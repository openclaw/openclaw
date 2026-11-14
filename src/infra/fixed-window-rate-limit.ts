import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

/** Process-local fixed-window quota; distributed limits require caller-owned persistence. */
export function createFixedWindowBudget(params: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}) {
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
          /** Milliseconds until the next fixed window when quota is exhausted. */
          retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
        };
      }
      count += 1;
      return {
        allowed: true,
        retryAfterMs: 0,
      };
    },
  };
}
