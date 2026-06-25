/**
 * JIMMY Eclipse Addon - PURE PORT of the official 8spine jimmy.js module.
 *
 * FAST VERSION: Uses Tidal CDN direct (sp-ad-cf.audio.tidal.com, 30ms TTFB)
 * instead of fly.dev (1-14s TTFB).
 *
 * Loads jimmy.js from jimmy-iota.vercel.app and wraps it as Eclipse HTTP endpoints.
 * /stream/:id returns /audio?m=<base64 manifest> URL.
 * /audio parses the DASH manifest, streams init + segments from Tidal CDN.
 *
 * FIX: W.I.S.H. seeking restart — fetches ACTUAL segment sizes from Tidal CDN
 * in parallel (~100ms) for exact Content-Length, instead of estimating.
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

const BACKEND_CACHE_BASE = 'https://lateralus-edge-cache.hatestar.workers.dev';
const BACKEND_CACHE_TOKEN = '230366616b3c69b13f3e11d07e633be855a36a4e9c9ec971152f50516dbee2ae';

function tidalCoverUrl(uuid, size) {
  if (!uuid) return null;
  const px = size || 640;
  return 'https://resources.tidal.com/images/' + uuid.replace(/-/g, '/') + '/' + px + 'x' + px + '.jpg';
}

// --- Settings URL rewriter ---
app.use((req, res, next) => {
  let m = req.url.match(/^\/cfg\/([a-z0-9]+)-([a-z]+)-(on|off)(\/.*)$/);
  if (m) { req.jimmySettings = { qobuz: m[1], tidal: m[2], max: m[3] }; req.url = m[4]; return next(); }
  m = req.url.match(/^\/cfg\/([a-z0-9]+)-([a-z]+)(\/.*)$/);
  if (m) { req.jimmySettings = { qobuz: m[1], tidal: m[2], max: (m[1] === 'hiresmax' ? 'on' : 'off') }; req.url = m[3]; return next(); }
  m = req.url.match(/^\/cfg\/([a-z0-9]+)(\/.*)$/);
  if (m) {
    const presets = {
      auto: { qobuz: 'hires', tidal: 'hireslossless', max: 'on' },
      lossless: { qobuz: 'cd', tidal: 'lossless', max: 'off' },
      hires: { qobuz: 'hires', tidal: 'hireslossless', max: 'off' },
      max: { qobuz: 'hires', tidal: 'hireslossless', max: 'on' }
    };
    req.jimmySettings = presets[m[1]] || presets.auto;
    req.url = m[2]; return next();
  }
  next();
});

// --- Load the official jimmy.js module ---
const JIMMY_SOURCE_URL = 'https://jimmy-iota.vercel.app/jimmy.js';
let jimmyModule = null;
let jimmyVersion = '2.4.21';

async function initJimmy() {
  if (jimmyModule) return jimmyModule;
  try {
    const src = await new Promise((resolve, reject) => {
      https.get(JIMMY_SOURCE_URL, (res) => {
        let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    jimmyModule = eval('(function() { ' + src + ' })()');
    jimmyVersion = jimmyModule.version || '2.4.21';
    console.log('[JIMMY] Module loaded: v' + jimmyVersion);
  } catch (e) { console.error('[JIMMY] Load failed:', e.message); }
  return jimmyModule;
}

function getTidalQuality(s) {
  return ({ low: 'LOW', high: 'HIGH', lossless: 'LOSSLESS', hireslossless: 'HI_RES_LOSSLESS' })[(s || {}).tidal] || 'HI_RES_LOSSLESS';
}
function getQobuzQuality(s) {
  s = s || {};
  return { quality: ({ mp3: 'MP3', cd: 'CD', hires: 'HIRES_96' })[s.qobuz] || 'HIRES_96', max: s.max === 'on' ? 'ON' : 'OFF' };
}

// --- Helper: HEAD request that returns just headers ---
function fetchHead(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'HEAD',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {}
    }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
      res.resume();
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// --- In-memory cache for segment sizes (fixes W.I.S.H. seeking) ---
const segSizeCache = new Map();
const SEG_SIZE_CACHE_TTL = 8 * 60 * 1000;

async function getSegmentSizes(initUrl, segUrls, manifestKey) {
  const cached = segSizeCache.get(manifestKey);
  if (cached && Date.now() - cached.time < SEG_SIZE_CACHE_TTL) return cached.sizes;
  const allUrls = [initUrl, ...segUrls];
  const promises = allUrls.map(url =>
    fetchHead(url)
      .then(r => parseInt(r.headers['content-length'] || '0'))
      .catch(() => 0)
  );
  const sizes = await Promise.all(promises);
  segSizeCache.set(manifestKey, { sizes, time: Date.now() });
  return sizes;
}

// === ENDPOINTS ===

app.get('/manifest.json', async (req, res) => {
  const mod = jimmyModule || await initJimmy();
  const name = (mod && mod.name) || 'JIMMY';
  const version = (mod && mod.version) || jimmyVersion;
  const author = (mod && mod.author) || 'Lateralus';
  const labels = (mod && mod.labels) || ['DOLBY-ATMOS', 'LOSSLESS', 'HI-RES', 'HI-RES(192kHz)'];
  const logo = (mod && mod.logo) || 'https://jimmy-iota.vercel.app/icon.png';

  res.json({
    id: 'com.lateralus.jimmy',
    name: name,
    version: version,
    description: 'Qobuz + Tidal hi-fi streaming for Eclipse',
    icon: logo,
    logo: logo,
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist'],
    contentType: 'music',
    author: author,
    labels: labels,
    license: 'MIT',
    homepage: 'https://github.com/bacard1i/Lateralus',
    tags: labels,
    pkg: 'com.lateralus.module.jimmy',
    engine: { spec: 'eclipse-addon/1.0', source: '8spine-module' }
  });
});

app.get('/search', async (req, res) => {
  const query = req.query.q || '';
  const limit = parseInt(req.query.limit) || 25;
  if (!query) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const mod = await initJimmy();
    if (!mod) throw new Error('Module not loaded');
    const [tRes, aRes, arRes] = await Promise.all([
      mod.searchTracks(query, limit).catch(() => ({ tracks: [] })),
      mod.searchAlbums(query, limit).catch(() => ({ albums: [] })),
      mod.searchArtists(query, limit).catch(() => ({ artists: [] }))
    ]);
    res.json({
      tracks: (tRes.tracks || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        artworkURL: t.albumCover, duration: t.duration, isrc: t.isrc, format: 'flac'
      })),
      albums: (aRes.albums || []).map(a => ({
        id: a.id, title: a.title, artist: a.artist, artworkURL: a.albumCover,
        year: a.year, trackCount: a.trackCount
      })),
      artists: (arRes.artists || []).map(ar => ({
        id: ar.id, name: ar.name, artworkURL: ar.picture
      })),
      playlists: []
    });
  } catch (err) { res.status(500).json({ error: 'Search failed' }); }
});

// Stream resolution - Tidal CDN via manifest (fast) with fly.dev fallback
app.get('/stream/:id', async (req, res) => {
  const id = req.params.id;
  const settings = req.jimmySettings || {};
  const tidalQuality = getTidalQuality(settings);
  const qobuz = getQobuzQuality(settings);
  try {
    const mod = await initJimmy();
    if (!mod) throw new Error('Module not loaded');
    const result = await mod.getTrackStreamUrl(id, null, {
      settings: {
        qobuzQuality: { value: qobuz.quality },
        qobuzHiResMax: { value: qobuz.max },
        tidalQuality: { value: tidalQuality }
      }
    });
    if (!result || !result.streamUrl) {
      return res.status(404).json({ error: 'No stream URL found' });
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    let audioUrl, format = 'flac';

    // Tidal: try manifest mode (Tidal CDN, 30ms TTFB)
    if (id.startsWith('tidal:')) {
      const rawId = id.split(':')[1];
      try {
        const tRes = await fetch(BACKEND_CACHE_BASE + '/track/?id=' + encodeURIComponent(rawId) +
          '&quality=' + tidalQuality + '&spatial=0', { headers: { 'X-Cache-Token': BACKEND_CACHE_TOKEN } });
        if (tRes.ok) {
          const tData = await tRes.json();
          if (tData.manifest) {
            audioUrl = proto + '://' + host + '/audio?m=' + encodeURIComponent(tData.manifest);
            if ((tData.mimeType || '').includes('aac')) format = 'aac';
          }
        }
      } catch (e) {}
    }

    // Fallback: return the direct streamUrl (Qobuz Akamai CDN, fly.dev, etc.)
    // Qobuz Akamai CDN supports HEAD + Range + CORS natively — AVPlayer can play it directly.
    // Do NOT proxy — proxying adds 270ms latency that causes AVPlayer to skip 24-bit Hi-Res FLAC files.
    if (!audioUrl) {
      audioUrl = result.streamUrl;
      const mimeType = result.track && result.track.mimeType ? result.track.mimeType : 'audio/flac';
      if (mimeType.includes('aac')) format = 'aac';
    }

    res.json({
      url: audioUrl,
      format: format,
      quality: result.track && result.track.audioQuality ? result.track.audioQuality : tidalQuality,
      expiresAt: Math.floor(Date.now() / 1000) + 600
    });
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).json({ error: 'Stream resolution failed' });
  }
});

// Audio proxy - handles both Tidal manifest mode (?m=) and URL passthrough mode (?url=)
// ?m=<base64 manifest>  → Tidal CDN direct streaming (fast, 30ms/segment)
// ?url=<any URL>        → passthrough proxy with CORS + HEAD synthesis (for Qobuz Akamai, fly.dev)
app.all('/audio', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Range');
    res.set('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Accept-Ranges, Content-Range',
  };

  // ── URL passthrough mode (?url=) — for Qobuz Akamai URLs, fly.dev, etc. ──
  // Proxies HEAD + GET+Range with CORS headers. Fixes Qobuz tracks skipping in Eclipse.
  const upstreamUrl = req.query.url;
  if (upstreamUrl) {
    try {
      // HEAD: return instantly with synthesized headers (no upstream probe needed
      // because Qobuz Akamai supports HEAD natively, but we proxy to add CORS)
      if (req.method === 'HEAD') {
        const probe = await fetch(upstreamUrl, { method: 'HEAD' });
        res.status(probe.status);
        if (probe.headers.get('content-type')) res.set('Content-Type', probe.headers.get('content-type'));
        if (probe.headers.get('content-length')) res.set('Content-Length', probe.headers.get('content-length'));
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'public, max-age=600');
        Object.entries(corsHeaders).forEach(([k, v]) => res.set(k, v));
        return res.end();
      }

      // GET: pass Range through, stream response byte-for-byte with CORS headers
      const reqHeaders = {};
      const range = req.headers['range'];
      if (range) reqHeaders['Range'] = range;

      const upstream = await fetch(upstreamUrl, { headers: reqHeaders, redirect: 'follow' });
      if (upstream.status !== 206 && upstream.status !== 200) {
        return res.status(502).json({ error: 'Upstream error: ' + upstream.status });
      }

      res.status(upstream.status);
      if (upstream.headers.get('content-type')) res.set('Content-Type', upstream.headers.get('content-type'));
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'public, max-age=600');
      if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range'));
      if (upstream.headers.get('content-length')) res.set('Content-Length', upstream.headers.get('content-length'));
      Object.entries(corsHeaders).forEach(([k, v]) => res.set(k, v));

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error: ' + e.message });
      else res.end();
    }
    return;
  }

  // ── Manifest mode (?m=) — Tidal CDN direct streaming ──
  const manifestB64 = req.query.m;
  if (!manifestB64) return res.status(400).json({ error: 'Missing ?m= or ?url=' });

  try {
    const xml = Buffer.from(decodeURIComponent(manifestB64), 'base64').toString('utf-8').replace(/&amp;/g, '&');
    const initUrl = xml.match(/initialization="([^"]+)"/)[1];
    const mediaTpl = xml.match(/media="([^"]+)"/)[1];
    const snMatch = xml.match(/startNumber="(\d+)"/);
    const startNumber = snMatch ? parseInt(snMatch[1]) : 1;
    const timeline = xml.match(/<SegmentTimeline>(.*?)<\/SegmentTimeline>/s)[1];
    let totalSegs = 0;
    for (const m of timeline.matchAll(/<S\s+([^/>]+)\/>/g)) {
      const r = m[1].match(/r="(\d+)"/);
      totalSegs += 1 + (r ? parseInt(r[1]) : 0);
    }
    const segUrls = [];
    for (let i = 0; i < totalSegs; i++) segUrls.push(mediaTpl.replace('$Number$', String(startNumber + i)));
    const allUrls = [initUrl, ...segUrls];

    // FIX: Fetch ACTUAL segment sizes in parallel from Tidal CDN (~100ms total)
    // This fixes W.I.S.H. seeking restart (estimation was 75KB off → AVPlayer miscalculated seeks)
    // Use full manifest as cache key (NOT substring — different tracks share XML prefix)
    const manifestKey = manifestB64;
    const segSizes = await getSegmentSizes(initUrl, segUrls, manifestKey);
    const exactTotal = segSizes.reduce((a, b) => a + b, 0);

    if (exactTotal === 0) {
      // Fallback to estimation if size fetch fails
      const initRes = await fetchHead(initUrl);
      const initSize = parseInt(initRes.headers['content-length'] || '0');
      const durMatch = xml.match(/mediaPresentationDuration="PT([0-9.]+)S"/);
      const duration = durMatch ? parseFloat(durMatch[1]) : 240;
      const bwMatch = xml.match(/bandwidth="(\d+)"/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 976120;
      const estimatedTotal = initSize + Math.ceil((bandwidth * duration) / 8);

      if (req.method === 'HEAD') {
        res.status(200);
        res.set('Content-Type', 'audio/mp4');
        res.set('Content-Length', String(estimatedTotal));
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'public, max-age=600');
        return res.end();
      }

      // GET with estimated size
      const rangeHdr = req.headers['range'];
      let start = 0, end = estimatedTotal - 1;
      if (rangeHdr) {
        const m = rangeHdr.match(/bytes=(\d+)-(\d*)/);
        if (m) { start = parseInt(m[1]); end = m[2] ? parseInt(m[2]) : estimatedTotal - 1; }
      }
      if (end >= estimatedTotal) end = estimatedTotal - 1;
      const length = end - start + 1;

      res.status(206);
      res.set('Content-Type', 'audio/mp4');
      res.set('Content-Length', String(length));
      res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + estimatedTotal);
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'public, max-age=600');

      let remaining = length;
      let currentPos = 0;

      for (let i = 0; i < allUrls.length && remaining > 0; i++) {
        const segUrl = allUrls[i];
        const skipFront = Math.max(0, start - currentPos);

        if (skipFront > 0) {
          if (segSizes[i] === undefined) {
            const p = await fetchHead(segUrl);
            segSizes[i] = parseInt(p.headers['content-length'] || '0');
          }
          if (currentPos + segSizes[i] <= start) {
            currentPos += segSizes[i];
            continue;
          }
        }

        const segHeaders = {};
        const readEnd = Math.min((segSizes[i] || 999999) - 1, end - currentPos);
        if (skipFront > 0 || (segSizes[i] && readEnd < segSizes[i] - 1)) {
          segHeaders['Range'] = 'bytes=' + skipFront + '-' + readEnd;
        }

        await new Promise((resolve, reject) => {
          const segReq = https.get(segUrl, { headers: segHeaders }, (segRes) => {
            if (segRes.statusCode !== 200 && segRes.statusCode !== 206) {
              segRes.resume();
              return reject(new Error('Seg ' + i + ' HTTP ' + segRes.statusCode));
            }
            if (segSizes[i] === undefined) {
              const cr = segRes.headers['content-range'];
              if (cr) { const m = cr.match(/bytes \d+-\d+\/(\d+)/); if (m) segSizes[i] = parseInt(m[1]); }
              else segSizes[i] = parseInt(segRes.headers['content-length'] || '0');
            }
            segRes.on('data', (chunk) => {
              const toWrite = chunk.slice(0, Math.min(chunk.length, remaining));
              if (toWrite.length > 0) { res.write(toWrite); remaining -= toWrite.length; currentPos += toWrite.length; }
              if (remaining <= 0) { segRes.destroy(); resolve(); }
            });
            segRes.on('end', resolve);
            segRes.on('error', reject);
          });
          segReq.on('error', reject);
        });
      }
      res.end();
      return;
    }

    // ── EXACT sizes path (W.I.S.H. seeking fix) ──
    if (req.method === 'HEAD') {
      res.status(200);
      res.set('Content-Type', 'audio/mp4');
      res.set('Content-Length', String(exactTotal));
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'public, max-age=600');
      return res.end();
    }

    // GET - stream segments with accurate byte mapping
    const rangeHdr = req.headers['range'];
    let start = 0, end = exactTotal - 1;
    if (rangeHdr) {
      const m = rangeHdr.match(/bytes=(\d+)-(\d*)/);
      if (m) { start = parseInt(m[1]); end = m[2] ? parseInt(m[2]) : exactTotal - 1; }
    }
    if (end >= exactTotal) end = exactTotal - 1;
    if (start > end) start = 0;
    const length = end - start + 1;

    res.status(206);
    res.set('Content-Type', 'audio/mp4');
    res.set('Content-Length', String(length));
    res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + exactTotal);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'public, max-age=600');

    let remaining = length;
    let currentPos = 0;

    for (let i = 0; i < allUrls.length && remaining > 0; i++) {
      const segUrl = allUrls[i];
      const segSize = segSizes[i];

      // Skip segments entirely before the requested range
      if (currentPos + segSize <= start) {
        currentPos += segSize;
        continue;
      }
      // Skip segments entirely after the requested range
      if (currentPos > end) break;

      const skipFront = Math.max(0, start - currentPos);
      const readEnd = Math.min(segSize - 1, end - currentPos);

      const segHeaders = {};
      if (skipFront > 0 || readEnd < segSize - 1) {
        segHeaders['Range'] = 'bytes=' + skipFront + '-' + readEnd;
      }

      await new Promise((resolve, reject) => {
        const segReq = https.get(segUrl, { headers: segHeaders }, (segRes) => {
          if (segRes.statusCode !== 200 && segRes.statusCode !== 206) {
            segRes.resume();
            return reject(new Error('Seg ' + i + ' HTTP ' + segRes.statusCode));
          }
          segRes.on('data', (chunk) => {
            const toWrite = chunk.slice(0, Math.min(chunk.length, remaining));
            if (toWrite.length > 0) { res.write(toWrite); remaining -= toWrite.length; currentPos += toWrite.length; }
            if (remaining <= 0) { segRes.destroy(); resolve(); }
          });
          segRes.on('end', resolve);
          segRes.on('error', reject);
        });
        segReq.on('error', reject);
        segReq.setTimeout(15000, () => segReq.destroy(new Error('segment timeout')));
      });
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Audio failed: ' + err.message });
    else res.end();
  }
});

app.get('/album/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const mod = await initJimmy();
    if (!mod) throw new Error('Module not loaded');
    const album = await mod.getAlbum(id);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    res.json({
      id: album.id, title: album.title, artist: album.artist,
      artworkURL: album.albumCover, year: album.year, trackCount: album.trackCount,
      tracks: (album.tracks || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist, album: album.title,
        duration: t.duration, artworkURL: t.albumCover || album.albumCover, format: 'flac'
      }))
    });
  } catch (err) { res.status(500).json({ error: 'Failed to get album' }); }
});

app.get('/artist/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const mod = await initJimmy();
    if (!mod) throw new Error('Module not loaded');
    const artist = await mod.getArtist(id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    let topTracks = (artist.topTracks || []).map(t => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      duration: t.duration, artworkURL: t.albumCover, format: 'flac'
    }));
    let albums = (artist.albums || []).map(a => ({
      id: a.id, title: a.title, artist: a.artist,
      artworkURL: a.albumCover, year: a.year, trackCount: a.trackCount
    }));

    if (topTracks.length === 0 && id.startsWith('tidal:')) {
      const rawId = id.split(':')[1];
      try {
        const tRes = await fetch(BACKEND_CACHE_BASE + '/artist/tracks/?id=' + rawId + '&limit=15',
          { headers: { 'X-Cache-Token': BACKEND_CACHE_TOKEN } });
        if (tRes.ok) {
          const tData = await tRes.json();
          topTracks = (tData.tracks || []).map(t => {
            const artists = t.artists || [];
            const album = t.album || {};
            return {
              id: 'tidal:' + t.id, title: t.title || 'Unknown',
              artist: (artists[0] && artists[0].name) || artist.name,
              album: album.title || '', duration: t.duration || 0,
              artworkURL: album.cover ? tidalCoverUrl(album.cover) : null, format: 'flac'
            };
          });
        }
      } catch (e) {}
    }

    if (albums.length === 0 && artist.name) {
      try {
        const aRes = await mod.searchAlbums(artist.name, 30);
        albums = (aRes.albums || [])
          .filter(a => a.artist && a.artist.toLowerCase() === artist.name.toLowerCase())
          .slice(0, 15)
          .map(a => ({
            id: a.id, title: a.title, artist: a.artist,
            artworkURL: a.albumCover, year: a.year, trackCount: a.trackCount
          }));
      } catch (e) {}
    }

    res.json({
      id: artist.id, name: artist.name, artworkURL: artist.picture,
      bio: artist.bio, topTracks, albums
    });
  } catch (err) { res.status(500).json({ error: 'Failed to get artist' }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', module: jimmyModule ? 'loaded' : 'not loaded', version: jimmyVersion });
});

app.get('/', (req, res) => {
  const baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>JIMMY - Eclipse Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0b0b0e;color:rgba(255,255,255,.88);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;padding:40px 20px}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:2em;margin-bottom:4px;color:#fff}
.version{color:rgba(255,255,255,.4);font-size:.85em;font-family:monospace;margin-bottom:24px}
.section{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:20px;margin-bottom:16px}
.section h2{font-size:.8em;text-transform:uppercase;letter-spacing:.05em;color:rgba(255,255,255,.4);margin-bottom:12px}
label{display:block;font-size:.85em;color:rgba(255,255,255,.55);margin-bottom:6px;margin-top:12px}
select{width:100%;padding:10px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#fff;font-size:.95em;cursor:pointer}
select:focus{outline:none;border-color:#00bcd4}
.gen-btn{width:100%;padding:12px;background:rgba(0,188,212,.12);border:1px solid rgba(0,188,212,.2);border-radius:8px;color:#00bcd4;cursor:pointer;font-weight:600;letter-spacing:.03em;font-size:.9em;transition:all .25s ease;margin-top:16px}
.gen-btn:hover{background:rgba(0,188,212,.2);border-color:rgba(0,188,212,.35);transform:translateY(-1px)}
.gen-btn:active{transform:translateY(0)}
.url-box{max-height:0;opacity:0;overflow:hidden;transition:max-height .4s cubic-bezier(.4,0,.2,1),opacity .3s ease .1s,margin-top .3s ease}
.url-box.show{max-height:200px;opacity:1;margin-top:16px}
.url-inner{position:relative;display:flex;align-items:center;gap:8px;background:rgba(0,188,212,.08);border:1px solid rgba(0,188,212,.2);border-radius:8px;padding:4px}
.url-inner input{flex:1;min-width:0;padding:10px 12px;background:transparent;border:none;color:#00bcd4;font-family:monospace;font-size:.75rem;word-break:break-all;overflow-wrap:break-word;white-space:pre-wrap;user-select:all;outline:none;line-height:1.5}
.url-inner button{flex-shrink:0;background:rgba(0,188,212,.15);border:1px solid rgba(0,188,212,.25);border-radius:6px;color:#00bcd4;cursor:pointer;padding:8px 14px;font-weight:600;letter-spacing:.05em;font-size:.8em;white-space:nowrap;transition:all .2s}
.url-inner button:hover{background:rgba(0,188,212,.3);color:#fff}
.hint{font-size:.8em;color:rgba(255,255,255,.35);margin-top:12px}
.links{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}
.links a{flex:1;min-width:120px;text-align:center;padding:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;color:rgba(255,255,255,.7);text-decoration:none;font-size:.85em;transition:all .2s}
.links a:hover{background:rgba(0,188,212,.08);border-color:rgba(0,188,212,.2);color:#00bcd4}
@media(max-width:480px){body{padding:20px 12px}h1{font-size:1.6em}.section{padding:16px}.url-inner{flex-direction:column;align-items:stretch;padding:8px;gap:8px}.url-inner input{font-size:.7rem;padding:8px 10px}.url-inner button{width:100%;padding:10px}}
</style>
</head>
<body>
<div class="wrap">
<h1>JIMMY</h1>
<div class="version">v${jimmyVersion} - Qobuz + Tidal streaming for Eclipse</div>
<div class="section">
<h2>Quality Presets</h2>
<label>Qobuz Audio Quality</label>
<select id="qobuz">
<option value="mp3">MP3 320kbps</option>
<option value="cd">CD - FLAC 16/44.1</option>
<option value="hires" selected>Hi-Res 24/96 (Default)</option>
</select>
<label>Hi-Res Max (24/192)</label>
<select id="max">
<option value="off">Off</option>
<option value="on" selected>On</option>
</select>
<label>Tidal Audio Quality</label>
<select id="tidal">
<option value="low">Low</option>
<option value="high">High</option>
<option value="lossless">Lossless</option>
<option value="hireslossless" selected>Hi-Res Lossless (Default)</option>
</select>
<button onclick="generateUrl()" class="gen-btn">Generate Manifest URL</button>
<div class="url-box" id="urlBox">
<div class="url-inner">
<input type="text" id="manifestUrl" readonly onclick="this.select()">
<button onclick="copyUrl()" title="Copy URL">COPY</button>
</div>
</div>
<p class="hint">Copy the manifest URL above, then in Eclipse: Connections &rarr; Add Connection &rarr; Addon.</p>
</div>
<div class="section">
<h2>Quick Links</h2>
<div class="links">
<a href="/manifest.json">Manifest</a>
<a href="/health">Health</a>
</div>
</div>
</div>
<script>
function generateUrl(){
  var q=document.getElementById('qobuz').value,t=document.getElementById('tidal').value,m=document.getElementById('max').value;
  var u='${baseUrl}/cfg/'+q+'-'+t+'-'+m+'/manifest.json';
  var input=document.getElementById('manifestUrl');
  var box=document.getElementById('urlBox');
  input.value=u;
  box.classList.add('show');
  setTimeout(function(){box.scrollIntoView({behavior:'smooth',block:'nearest'})},200);
  var btn=document.querySelector('.gen-btn');
  var orig=btn.textContent;
  btn.textContent='Generated!';
  btn.style.background='rgba(0,188,212,.25)';
  setTimeout(function(){btn.textContent=orig;btn.style.background=''},1500);
}
function copyUrl(){
  var i=document.getElementById('manifestUrl');
  i.select();
  i.setSelectionRange(0,99999);
  if(navigator.clipboard){
    navigator.clipboard.writeText(i.value).then(function(){
      var b=document.querySelector('.url-inner button');
      var t=b.textContent;b.textContent='COPIED!';
      setTimeout(function(){b.textContent=t},1500);
    });
  }else{
    document.execCommand('copy');
    var b=document.querySelector('.url-inner button');
    var t=b.textContent;b.textContent='COPIED!';
    setTimeout(function(){b.textContent=t},1500);
  }
}
</script>
</body>
</html>`);
});

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log('JIMMY Eclipse addon running on http://0.0.0.0:' + PORT));
}
