/**
 * Generic circuit breaker for protecting against cascading failures.
 *
 * States:
 *   closed   – requests flow through normally; failures are counted
 *   open     – requests are rejected immediately; after resetMs elapses, transitions to half-open
 *   half-open – a single probe request is allowed; success closes, failure re-opens
 */

export type CircuitBreakerState = "closed" | "open" | "half-open";

export type CircuitBreakerOptions = {
  /** Number of consecutive failures before opening the circuit (default: 5). */
  failureThreshold?: number;
  /** Milliseconds to wait before transitioning from open to half-open (default: 30 000). */
  resetMs?: number;
  /** Optional predicate to decide whether an error should count as a circuit-breaker failure. */
  shouldTrip?: (err: unknown) => boolean;
  /** Clock override for testing. */
  now?: () => number;
};

export type CircuitBreaker = {
  /** Execute `fn` through the circuit breaker. Throws `CircuitBreakerOpenError` when open. */
  call: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Current state. */
  state: () => CircuitBreakerState;
  /** Manually reset to closed. */
  reset: () => void;
  /** Current consecutive failure count. */
  failures: () => number;
};

export class CircuitBreakerOpenError extends Error {
  readonly remainingMs: number;

  constructor(remainingMs: number) {
    super(`Circuit breaker is open (resets in ${Math.ceil(remainingMs / 1000)}s)`);
    this.name = "CircuitBreakerOpenError";
    this.remainingMs = remainingMs;
  }
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_MS = 30_000;

export function createCircuitBreaker(options?: CircuitBreakerOptions): CircuitBreaker {
  const failureThreshold = Math.max(1, options?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
  const resetMs = Math.max(0, options?.resetMs ?? DEFAULT_RESET_MS);
  const shouldTrip = options?.shouldTrip ?? (() => true);
  const now = options?.now ?? Date.now;

  let currentState: CircuitBreakerState = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;

  function transitionTo(next: CircuitBreakerState): void {
    currentState = next;
    if (next === "open") {
      openedAt = now();
    }
  }

  function onSuccess(): void {
    consecutiveFailures = 0;
    transitionTo("closed");
  }

  function onFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) {
      transitionTo("open");
    }
  }

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    if (currentState === "open") {
      const elapsed = now() - openedAt;
      if (elapsed >= resetMs) {
        transitionTo("half-open");
      } else {
        throw new CircuitBreakerOpenError(resetMs - elapsed);
      }
    }

    try {
      const result = await fn();
      onSuccess();
      return result;
    } catch (err) {
      if (shouldTrip(err)) {
        if (currentState === "half-open") {
          // Probe failed; re-open immediately.
          consecutiveFailures = failureThreshold;
          transitionTo("open");
        } else {
          onFailure();
        }
      }
      throw err;
    }
  }

  return {
    call,
    state: () => currentState,
    reset: () => {
      consecutiveFailures = 0;
      currentState = "closed";
      openedAt = 0;
    },
    failures: () => consecutiveFailures,
  };
}
