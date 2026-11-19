import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../../packages/gateway-client/src/timeouts.js";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";

export class SessionModelCatalogUnavailableError extends Error {
  readonly error = errorShape(ErrorCodes.UNAVAILABLE, this.message, { retryable: true });
}

export function createSessionModelCatalogWait(
  signals: Array<AbortSignal | undefined>,
  outcome = "The session was not created",
) {
  let deadline: number | undefined;
  const unavailable = new SessionModelCatalogUnavailableError(
    `The model catalog is still loading. ${outcome}; retry shortly.`,
  );
  const stop = (): never => {
    throw unavailable;
  };
  return {
    unavailable,
    run: async <T>(operation: () => Promise<T>, authoritySignal?: AbortSignal): Promise<T> => {
      const signal = AbortSignal.any(
        [...signals, authoritySignal].filter((value): value is AbortSignal => value !== undefined),
      );
      if (signal.aborted) {
        stop();
      }
      // Leave response headroom below the Gateway client's request budget.
      deadline ??= performance.now() + (DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS * 2) / 3;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        stop();
      }
      return raceWithTimeout(operation, remaining, stop, { signal, onAbort: stop });
    },
    settle: async <T>(
      operation: Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false; error: ErrorShape }> => {
      try {
        return { ok: true, value: await operation };
      } catch (error) {
        if (error !== unavailable) {
          throw error;
        }
        return { ok: false, error: unavailable.error };
      }
    },
  };
}
