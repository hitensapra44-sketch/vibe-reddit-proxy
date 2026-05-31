const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Rate limiter — max 25 requests per minute per IP
const rateLimits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const window = 60 * 1000;
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, []);
  }
  const timestamps = rateLimits.get(ip).filter(t => now - t < window);
  timestamps.push(now);
  rateLimits.set(ip, timestamps);
  return timestamps.length > 25;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchReddit(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });

      if (res.status === 429) {
        // Rate limited by Reddit — wait and retry
        const wait = (i + 1) * 2000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text), status: res.status };
      } catch {
        return { ok: false, error: 'Non-JSON response from Reddit', status: res.status, body: text.substring(0, 300) };
      }
    } catch (e) {
      if (i === retries - 1) return { ok: false, error: e.message };
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { ok: false, error: 'Max retries exceeded' };
}

app.get('/search', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const { q, sub, sort = 'new', t = 'week', limit = 25 } = req.query;
  
  if (!q) return res.status(400).json({ error: 'Missing query param q' });

  let redditUrl;
  if (sub) {
    redditUrl = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(q)}&sort=${sort}&t=${t}&limit=${limit}&restrict_sr=true`;
  } else {
    redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=${sort}&t=${t}&limit=${limit}`;
  }

  // Check cache
  const cacheKey = redditUrl;
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) {
      return res.json({ ...data, fromCache: true });
    }
    cache.delete(cacheKey);
  }

  const result = await fetchReddit(redditUrl);
  
  if (result.ok) {
    cache.set(cacheKey, { data: result.data, timestamp: Date.now() });
    return res.json(result.data);
  } else {
    return res.status(result.status || 500).json({ error: result.error, body: result.body });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reddit proxy running on port ${PORT}`));
