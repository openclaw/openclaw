/**
 * In-memory token-bucket rate limiter.
 *
 * Each instance tracks buckets keyed by a string (IP, client ID, token hash, etc.).
 * A background GC sweep removes stale entries to prevent unbounded memory growth.
 */

export type RateLimiterConfig = {
  /** Maximum tokens (burst capacity). */
  maxTokens: number;
  /** Tokens refilled per interval. */
  refillRate: number;
  /** Refill interval in milliseconds. */
  refillIntervalMs: number;
};

export type RateLimitResult = {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Milliseconds until a token is available (set when denied). */
  retryAfterMs?: number;
  /** Remaining tokens after this check. */
  remaining: number;
};

type Bucket = {
  tokens: number;
  lastRefill: number;
  lastAccess: number;
};

/** How often the GC sweep runs (ms). */
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Buckets untouched for this long are evicted (ms). */
const GC_STALE_MS = 10 * 60 * 1000; // 10 minutes

export class RateLimiter {
  private readonly config: Readonly<RateLimiterConfig>;
  private readonly buckets = new Map<string, Bucket>();
  private gcTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: RateLimiterConfig) {
    this.config = Object.freeze({ ...config });
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    this.gcTimer.unref();
  }

  /**
   * Consume one token for `key`. Returns whether the request is allowed,
   * plus remaining tokens and an optional retry-after hint.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.config.maxTokens, lastRefill: now, lastAccess: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time.
    this.refill(bucket, now);
    bucket.lastAccess = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: bucket.tokens };
    }

    // Denied — compute how long until at least one token is available.
    // `refill()` already ran, so `now - bucket.lastRefill` is the elapsed
    // time within the current (incomplete) interval: always in [0, refillIntervalMs).
    const deficit = 1 - bucket.tokens;
    const intervalsNeeded = Math.ceil(deficit / this.config.refillRate);
    const elapsedInCurrentInterval = now - bucket.lastRefill;
    const retryAfterMs = intervalsNeeded * this.config.refillIntervalMs - elapsedInCurrentInterval;

    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  /** Clear the bucket for a specific key (e.g. on successful auth). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Stop the GC timer. Call this in test teardown or clean shutdown. */
  destroy(): void {
    if (this.gcTimer !== undefined) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  /** Visible for testing — number of tracked buckets. */
  get size(): number {
    return this.buckets.size;
  }

  // --- internal ---

  private refill(bucket: Bucket, now: number): void {
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) {
      return;
    }

    const intervals = Math.floor(elapsed / this.config.refillIntervalMs);
    if (intervals <= 0) {
      return;
    }

    const refilled = intervals * this.config.refillRate;
    bucket.tokens = Math.min(this.config.maxTokens, bucket.tokens + refilled);
    bucket.lastRefill += intervals * this.config.refillIntervalMs;
  }

  /** Remove buckets that have not been accessed recently. */
  private gc(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastAccess >= GC_STALE_MS) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Exposed for testing only — run the GC sweep with a custom timestamp.
   * @internal
   */
  _gcForTest(now: number): void {
    this.gc(now);
  }
}
