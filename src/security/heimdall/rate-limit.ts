/**
 * Heimdall Rate Limiter — per-sender sliding window throttle.
 *
 * In-memory sliding window with periodic cleanup.
 * OWNER is always bypassed. GUEST has stricter limits.
 */

import { SenderTier, type HeimdallRateLimitConfig, type RateLimitResult } from "./types.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_GUEST_MAX_MESSAGES = 5;
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Binary search for the first index where timestamps[i] > cutoff.
 * Returns 0 if no entries are expired. Returns timestamps.length if all expired.
 */
function findFirstValidIndex(timestamps: number[], cutoff: number): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] <= cutoff) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export class HeimdallRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxMessages: number;
  private readonly guestMaxMessages: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HeimdallRateLimitConfig) {
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.guestMaxMessages = config.guestMaxMessages ?? DEFAULT_GUEST_MAX_MESSAGES;

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Don't prevent process exit
    if (this.cleanupTimer?.unref) {
      this.cleanupTimer.unref();
    }
  }

  check(senderId: string | number, senderTier: SenderTier): RateLimitResult {
    // OWNER is never rate-limited
    if (senderTier === SenderTier.OWNER) {
      return { allowed: true, remaining: Infinity, resetMs: 0 };
    }

    const key = String(senderId);
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const limit = senderTier === SenderTier.GUEST ? this.guestMaxMessages : this.maxMessages;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Remove expired entries (binary search for cutoff boundary — O(log n))
    const firstValid = findFirstValidIndex(timestamps, cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }

    if (timestamps.length >= limit) {
      const oldestTs = timestamps[0];
      const resetMs = oldestTs + this.windowMs - now;
      return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
    }

    timestamps.push(now);
    return {
      allowed: true,
      remaining: limit - timestamps.length,
      resetMs: timestamps.length > 0 ? timestamps[0] + this.windowMs - now : this.windowMs,
    };
  }

  /** Remove expired sender windows. */
  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const firstValid = findFirstValidIndex(timestamps, cutoff);
      if (firstValid > 0) {
        timestamps.splice(0, firstValid);
      }
      if (timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  /** Stop the cleanup timer (for testing / shutdown). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}

let singleton: HeimdallRateLimiter | null = null;
let singletonConfigKey: string | undefined;

/** Stable cache key from rate limit config fields that affect behavior. */
function rateLimitConfigKey(config: HeimdallRateLimitConfig): string {
  return `${config.windowMs ?? DEFAULT_WINDOW_MS}:${config.maxMessages ?? DEFAULT_MAX_MESSAGES}:${config.guestMaxMessages ?? DEFAULT_GUEST_MAX_MESSAGES}`;
}

export function getHeimdallRateLimiter(
  config?: HeimdallRateLimitConfig,
): HeimdallRateLimiter | null {
  if (!config?.enabled) {
    return null;
  }
  const key = rateLimitConfigKey(config);
  if (singleton && singletonConfigKey === key) {
    return singleton;
  }
  singleton?.destroy();
  singleton = new HeimdallRateLimiter(config);
  singletonConfigKey = key;
  return singleton;
}

/** Reset singleton (for testing). */
export function __resetRateLimiter(): void {
  singleton?.destroy();
  singleton = null;
  singletonConfigKey = undefined;
}
