import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export type FixedWindowRateLimiter = {
  consume: () => {
    allowed: boolean;
    /** Milliseconds until the next fixed window when quota is exhausted. */
    retryAfterMs: number;
    /** Requests left in the current window after this consume call. */
    remaining: number;
  };
  /** Clears the current fixed-window count and starts fresh on the next consume call. */
  reset: () => void;
};

/** Process-local fixed-window quota; distributed limits require caller-owned persistence. */
export function createFixedWindowBudget(params: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): FixedWindowRateLimiter {
  const maxRequests = resolveIntegerOption(params.maxRequests, 1, { min: 1 });
  const windowMs = resolveIntegerOption(params.windowMs, 1, { min: 1 });
  const now = params.now ?? Date.now;

  let count = 0;
  let windowStartMs = 0;

  return {
    consume() {
      const nowMs = now();
      if (nowMs - windowStartMs >= windowMs) {
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
