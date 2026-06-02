/**
 * Single-bucket fixed-window limiter for bursty control-plane actions. It keeps
 * only one counter and one window start, so callers that need per-key limits
 * should create/cache one limiter per key.
 */
export type FixedWindowRateLimiter = {
  consume: () => {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
  };
  reset: () => void;
};

/**
 * Normalize integer rate-limit options while keeping operator-provided minimums.
 * Invalid values fall back before clamping so config parsing cannot disable a
 * limiter by passing NaN or fractional values.
 */
export function resolveFixedWindowRateLimitInteger(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(params.min, Math.floor(candidate));
}

/**
 * Create a single in-memory fixed-window limiter with clamped integer bounds.
 * The limiter is process-local and intentionally non-persistent; it protects
 * hot paths from bursts rather than enforcing durable quotas.
 */
export function createFixedWindowRateLimiter(params: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): FixedWindowRateLimiter {
  const maxRequests = resolveFixedWindowRateLimitInteger(params.maxRequests, 1, { min: 1 });
  const windowMs = resolveFixedWindowRateLimitInteger(params.windowMs, 1, { min: 1 });
  const now = params.now ?? Date.now;

  let count = 0;
  let windowStartMs = 0;

  return {
    consume() {
      const nowMs = now();
      if (nowMs - windowStartMs >= windowMs) {
        // Window ownership is lazy: first consume after expiry starts the next bucket.
        windowStartMs = nowMs;
        count = 0;
      }
      if (count >= maxRequests) {
        return {
          allowed: false,
          retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
          remaining: 0,
        };
      }
      count += 1;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.max(0, maxRequests - count),
      };
    },
    reset() {
      // Reset returns the limiter to cold-start state so the next consume opens a fresh window.
      count = 0;
      windowStartMs = 0;
    },
  };
}
