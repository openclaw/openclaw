/** Minimal fixed-window limiter interface used by memory and request guard helpers. */
export type FixedWindowRateLimiter = {
  consume: () => {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
  };
  reset: () => void;
};

/** Normalizes rate-limit numeric config to a finite integer with a lower bound. */
export function resolveFixedWindowRateLimitInteger(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(params.min, Math.floor(candidate));
}

/** Creates a fixed-window counter that reports allowance, remaining quota, and retry delay. */
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
        // Fixed-window semantics reset all quota at the first request after the window expires.
        windowStartMs = nowMs;
        count = 0;
      }
      if (count >= maxRequests) {
        // Clamp retryAfterMs for injected clocks that move unexpectedly between consume calls.
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
      count = 0;
      windowStartMs = 0;
    },
  };
}
