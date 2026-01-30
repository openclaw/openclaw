/**
 * Rate limiter with token bucket + sliding window
 * Uses LRU cache to prevent memory exhaustion
 */

import { TokenBucket, createTokenBucket } from "./token-bucket.js";

export interface RateLimit {
  max: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  remaining: number;
  resetAt: Date;
}

interface CacheEntry {
  bucket: TokenBucket;
  lastAccess: number;
}

const MAX_CACHE_SIZE = 10_000;
const CACHE_CLEANUP_INTERVAL_MS = 60_000; // 1 minute
const CACHE_TTL_MS = 120_000; // 2 minutes

/**
 * LRU cache for rate limit buckets
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private accessOrder: K[] = [];

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
      this.accessOrder.push(key);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key exists, remove it from access order
    if (this.cache.has(key)) {
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
    }

    // Add to cache
    this.cache.set(key, value);
    this.accessOrder.push(key);

    // Evict least recently used if over capacity
    while (this.cache.size > this.maxSize && this.accessOrder.length > 0) {
      const lru = this.accessOrder.shift();
      if (lru !== undefined) {
        this.cache.delete(lru);
      }
    }
  }

  delete(key: K): boolean {
    this.accessOrder = this.accessOrder.filter((k) => k !== key);
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  size(): number {
    return this.cache.size;
  }

  keys(): K[] {
    return Array.from(this.cache.keys());
  }
}

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private buckets: LRUCache<string, CacheEntry>;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(params?: { maxSize?: number }) {
    this.buckets = new LRUCache<string, CacheEntry>(params?.maxSize ?? MAX_CACHE_SIZE);
    this.startCleanup();
  }

  /**
   * Check if a request should be allowed
   * Returns rate limit result
   */
  check(key: string, limit: RateLimit): RateLimitResult {
    const entry = this.getOrCreateEntry(key, limit);
    const allowed = entry.bucket.consume(1);
    const remaining = entry.bucket.getTokens();
    const retryAfterMs = allowed ? undefined : entry.bucket.getRetryAfterMs(1);
    const resetAt = new Date(Date.now() + limit.windowMs);

    entry.lastAccess = Date.now();

    return {
      allowed,
      retryAfterMs,
      remaining: Math.max(0, Math.floor(remaining)),
      resetAt,
    };
  }

  /**
   * Check without consuming (peek)
   */
  peek(key: string, limit: RateLimit): RateLimitResult {
    const entry = this.buckets.get(key);

    if (!entry) {
      // Not rate limited yet - full capacity available
      return {
        allowed: true,
        remaining: limit.max,
        resetAt: new Date(Date.now() + limit.windowMs),
      };
    }

    const remaining = entry.bucket.getTokens();
    const wouldAllow = remaining >= 1;
    const retryAfterMs = wouldAllow ? undefined : entry.bucket.getRetryAfterMs(1);
    const resetAt = new Date(Date.now() + limit.windowMs);

    return {
      allowed: wouldAllow,
      retryAfterMs,
      remaining: Math.max(0, Math.floor(remaining)),
      resetAt,
    };
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.buckets.clear();
  }

  /**
   * Get current cache size
   */
  getCacheSize(): number {
    return this.buckets.size();
  }

  /**
   * Get statistics
   */
  getStats(): {
    cacheSize: number;
    maxCacheSize: number;
  } {
    return {
      cacheSize: this.buckets.size(),
      maxCacheSize: MAX_CACHE_SIZE,
    };
  }

  /**
   * Stop cleanup interval (for testing)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get or create cache entry for a key
   */
  private getOrCreateEntry(key: string, limit: RateLimit): CacheEntry {
    let entry = this.buckets.get(key);

    if (!entry) {
      entry = {
        bucket: createTokenBucket(limit),
        lastAccess: Date.now(),
      };
      this.buckets.set(key, entry);
    }

    return entry;
  }

  /**
   * Start periodic cleanup of stale entries
   */
  private startCleanup(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, CACHE_CLEANUP_INTERVAL_MS);

    // Don't keep process alive for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Clean up stale cache entries
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const key of this.buckets.keys()) {
      const entry = this.buckets.get(key);
      if (entry && now - entry.lastAccess > CACHE_TTL_MS) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.buckets.delete(key);
    }
  }
}

/**
 * Singleton rate limiter instance
 */
export const rateLimiter = new RateLimiter();

/**
 * Rate limit key generators
 */
export const RateLimitKeys = {
  authAttempt: (ip: string) => `auth:${ip}`,
  authAttemptDevice: (deviceId: string) => `auth:device:${deviceId}`,
  connection: (ip: string) => `conn:${ip}`,
  request: (ip: string) => `req:${ip}`,
  pairingRequest: (channel: string, sender: string) => `pair:${channel}:${sender}`,
  webhookToken: (token: string) => `hook:token:${token}`,
  webhookPath: (path: string) => `hook:path:${path}`,
} as const;
