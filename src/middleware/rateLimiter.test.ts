import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createRateLimiter,
  InMemoryBackend,
  keyExtractors,
  type RateLimitRequest,
} from './rateLimiter.js';

describe('InMemoryBackend', () => {
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend(600_000); // long GC for tests
  });

  afterEach(() => {
    backend.destroy();
  });

  it('records hits and returns correct count', async () => {
    const info = await backend.hit('key1', 60_000);
    expect(info.count).toBe(1);

    const info2 = await backend.hit('key1', 60_000);
    expect(info2.count).toBe(2);
  });

  it('evicts expired entries', async () => {
    const now = 1000;
    await backend.hit('key1', 100, now);
    await backend.hit('key1', 100, now + 50);
    // After the window, old entry is evicted
    const info = await backend.hit('key1', 100, now + 150);
    expect(info.count).toBe(2); // only now+50 and now+150
  });

  it('peek does not add a hit', async () => {
    await backend.hit('key1', 60_000);
    const info = await backend.peek('key1', 60_000);
    expect(info.count).toBe(1);
  });

  it('peek on unknown key returns zero count', async () => {
    const info = await backend.peek('unknown', 60_000);
    expect(info.count).toBe(0);
  });

  it('reset clears key data', async () => {
    await backend.hit('key1', 60_000);
    await backend.reset('key1');
    const info = await backend.peek('key1', 60_000);
    expect(info.count).toBe(0);
  });
});

describe('keyExtractors', () => {
  it('byIP returns IP', () => {
    expect(keyExtractors.byIP({ ip: '1.2.3.4' })).toBe('1.2.3.4');
  });

  it('byIP returns null for missing IP', () => {
    expect(keyExtractors.byIP({})).toBeNull();
  });

  it('byUserId returns userId', () => {
    expect(keyExtractors.byUserId({ userId: 'u123' })).toBe('u123');
  });

  it('byApiKey reads from header', () => {
    expect(
      keyExtractors.byApiKey({ headers: { 'x-api-key': 'abc' } }),
    ).toBe('abc');
  });

  it('byApiKey prefers field over header', () => {
    expect(
      keyExtractors.byApiKey({ apiKey: 'field', headers: { 'x-api-key': 'hdr' } }),
    ).toBe('field');
  });

  it('byIPAndPath combines IP and path', () => {
    expect(keyExtractors.byIPAndPath({ ip: '1.2.3.4', path: '/api' })).toBe(
      '1.2.3.4:/api',
    );
  });
});

describe('createRateLimiter', () => {
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend(600_000);
  });

  afterEach(() => {
    backend.destroy();
  });

  it('allows requests under the limit', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 5, windowMs: 60_000 },
      backend,
    });

    const req: RateLimitRequest = { ip: '1.2.3.4' };
    const result = await limiter(req);
    expect(result.allowed).toBe(true);
    expect(result.headers['X-RateLimit-Limit']).toBe('5');
    expect(result.headers['X-RateLimit-Remaining']).toBe('4');
  });

  it('blocks requests over the limit', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 2, windowMs: 60_000 },
      backend,
    });

    const req: RateLimitRequest = { ip: '10.0.0.1' };
    await limiter(req);
    await limiter(req);
    const result = await limiter(req);

    expect(result.allowed).toBe(false);
    expect(result.response?.statusCode).toBe(429);
    expect(result.headers['Retry-After']).toBeDefined();
  });

  it('bypasses keys in the bypass list', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 1, windowMs: 60_000 },
      backend,
      bypassKeys: new Set(['admin-ip']),
      keyExtractor: (req) => req.ip ?? null,
    });

    const req: RateLimitRequest = { ip: 'admin-ip' };
    await limiter(req);
    await limiter(req);
    const result = await limiter(req);
    expect(result.allowed).toBe(true);
  });

  it('returns allowed=true when key is null', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 1, windowMs: 60_000 },
      backend,
      keyExtractor: () => null,
    });
    const result = await limiter({});
    expect(result.allowed).toBe(true);
    expect(Object.keys(result.headers)).toHaveLength(0);
  });

  it('uses custom status code and message', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 1, windowMs: 60_000 },
      backend,
      statusCode: 503,
      message: 'Slow down!',
    });

    const req: RateLimitRequest = { ip: '5.5.5.5' };
    await limiter(req);
    const result = await limiter(req);

    expect(result.response?.statusCode).toBe(503);
    expect(JSON.parse(result.response!.body).error).toBe('Slow down!');
  });

  it('applies per-key rules', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 100, windowMs: 60_000 },
      keyRules: new Map([['vip', { limit: 1000, windowMs: 60_000 }]]),
      backend,
      keyExtractor: (req) => req.userId ?? null,
    });

    const result = await limiter({ userId: 'vip' });
    expect(result.headers['X-RateLimit-Limit']).toBe('1000');
  });

  it('includes rate limit headers on every response', async () => {
    const limiter = createRateLimiter({
      defaultRule: { limit: 10, windowMs: 60_000 },
      backend,
    });

    const result = await limiter({ ip: '7.7.7.7' });
    expect(result.headers).toHaveProperty('X-RateLimit-Limit');
    expect(result.headers).toHaveProperty('X-RateLimit-Remaining');
    expect(result.headers).toHaveProperty('X-RateLimit-Reset');
  });
});
