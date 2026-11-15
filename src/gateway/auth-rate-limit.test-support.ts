import { vi } from "vitest";
import type { AuthRateLimiter } from "./auth-rate-limit.js";

export function createLimiterSpy(): AuthRateLimiter & {
  check: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn<AuthRateLimiter["check"]>(
    (_ip, _scope) => ({ allowed: true, remaining: 10, retryAfterMs: 0 }) as const,
  );
  const recordFailure = vi.fn<AuthRateLimiter["recordFailure"]>((_ip, _scope) => {});
  const recordFailureAndDelay = vi.fn<AuthRateLimiter["recordFailureAndDelay"]>(
    async (ip, scope) => {
      recordFailure(ip, scope);
    },
  );
  const reset = vi.fn<AuthRateLimiter["reset"]>((_ip, _scope) => {});
  return {
    check,
    recordFailure,
    recordFailureAndDelay,
    reset,
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}
