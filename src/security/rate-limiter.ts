/**
 * Rate Limiter
 *
 * Sliding window rate limiting per category per session.
 * Prevents resource exhaustion and abuse.
 *
 * Addresses: T-IMPACT-002 (P1), R-004 (P1)
 */

import type { SecurityRateLimitBucket } from "../config/types.openclaw.js";

export type RateLimitCategory = string;

export type RateLimitResult = {
  allowed: boolean;
  category: RateLimitCategory;
  remaining: number;
  resetMs: number;
};

type BucketConfig = {
  windowMs: number;
  maxCount: number;
};

type BucketState = {
  timestamps: number[];
};

const DEFAULT_BUCKETS: Record<string, BucketConfig> = {
  "tool-call": { windowMs: 60_000, maxCount: 60 },
  exec: { windowMs: 60_000, maxCount: 20 },
  "web-fetch": { windowMs: 60_000, maxCount: 30 },
  "message-send": { windowMs: 60_000, maxCount: 10 },
};

export class RateLimiter {
  private bucketConfigs: Map<string, BucketConfig>;
  /** Map<sessionKey::category, BucketState> */
  private states = new Map<string, BucketState>();

  constructor(customBuckets?: SecurityRateLimitBucket[]) {
    this.bucketConfigs = new Map(Object.entries(DEFAULT_BUCKETS));

    if (customBuckets) {
      for (const bucket of customBuckets) {
        this.bucketConfigs.set(bucket.category, {
          windowMs: bucket.windowMs ?? DEFAULT_BUCKETS[bucket.category]?.windowMs ?? 60_000,
          maxCount: bucket.maxCount ?? DEFAULT_BUCKETS[bucket.category]?.maxCount ?? 60,
        });
      }
    }
  }

  /**
   * Check if an action is allowed and record it if so.
   */
  check(category: RateLimitCategory, sessionKey?: string): RateLimitResult {
    const config = this.bucketConfigs.get(category);
    if (!config) {
      return { allowed: true, category, remaining: Infinity, resetMs: 0 };
    }

    const stateKey = `${sessionKey ?? "global"}::${category}`;
    let state = this.states.get(stateKey);
    if (!state) {
      state = { timestamps: [] };
      this.states.set(stateKey, state);
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Remove expired timestamps
    state.timestamps = state.timestamps.filter((ts) => ts > windowStart);

    if (state.timestamps.length >= config.maxCount) {
      const oldestInWindow = state.timestamps[0] ?? now;
      const resetMs = oldestInWindow + config.windowMs - now;
      return {
        allowed: false,
        category,
        remaining: 0,
        resetMs: Math.max(0, resetMs),
      };
    }

    // Record this action
    state.timestamps.push(now);

    return {
      allowed: true,
      category,
      remaining: config.maxCount - state.timestamps.length,
      resetMs: 0,
    };
  }

  /**
   * Get current state for a category without recording an action.
   */
  peek(category: RateLimitCategory, sessionKey?: string): RateLimitResult {
    const config = this.bucketConfigs.get(category);
    if (!config) {
      return { allowed: true, category, remaining: Infinity, resetMs: 0 };
    }

    const stateKey = `${sessionKey ?? "global"}::${category}`;
    const state = this.states.get(stateKey);
    if (!state) {
      return { allowed: true, category, remaining: config.maxCount, resetMs: 0 };
    }

    const now = Date.now();
    const windowStart = now - config.windowMs;
    const activeCount = state.timestamps.filter((ts) => ts > windowStart).length;
    const remaining = Math.max(0, config.maxCount - activeCount);

    return {
      allowed: remaining > 0,
      category,
      remaining,
      resetMs: 0,
    };
  }

  /**
   * Reset rate limits for a session (useful when kill switch deactivated).
   */
  resetSession(sessionKey: string): void {
    const prefix = `${sessionKey}::`;
    for (const key of this.states.keys()) {
      if (key.startsWith(prefix)) {
        this.states.delete(key);
      }
    }
  }

  /**
   * Reset all rate limits.
   */
  resetAll(): void {
    this.states.clear();
  }

  /**
   * Map a tool name to a rate limit category.
   */
  static toolCategory(toolName: string): RateLimitCategory {
    const lower = toolName.toLowerCase();
    if (lower === "exec" || lower === "process") {
      return "exec";
    }
    if (lower === "web_fetch" || lower === "web_search") {
      return "web-fetch";
    }
    if (lower === "message" || lower === "sessions_send") {
      return "message-send";
    }
    return "tool-call";
  }
}
