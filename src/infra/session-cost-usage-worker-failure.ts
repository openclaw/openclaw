import {
  collectErrorGraphCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { UsageCostWorkerReplyError } from "./session-cost-usage-worker.types.js";
import { withSqliteWorkerCleanupFailure } from "./sqlite-worker-broker-reply.js";

export function restoreWorkerFailure(error: unknown, hostErrors: Map<number, unknown>): unknown {
  const restoredOrigins = new Set<number>();
  let result = error;
  for (const current of collectErrorGraphCandidates(error, (entry) =>
    entry instanceof Error
      ? [entry.cause, ...(entry instanceof AggregateError ? entry.errors : [])]
      : [],
  )) {
    if (current instanceof UsageCostWorkerReplyError) {
      const failure = current.failure;
      const remote = new Error(failure.message);
      if (failure.error) {
        retainOpenClawStateWorkerErrorPayload(remote, failure.error);
      }
      let restored: unknown = hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
      if (failure.hostOrigin !== undefined && hostErrors.has(failure.hostOrigin)) {
        restoredOrigins.add(failure.hostOrigin);
        const original = hostErrors.get(failure.hostOrigin);
        restored = failure.hostFailureOnly
          ? original
          : withSqliteWorkerCleanupFailure(
              toErrorObject(original, "Usage cache host effect failed"),
              restored,
            );
      }
      result =
        current === error
          ? restored
          : withSqliteWorkerCleanupFailure(
              toErrorObject(restored, "Usage cost worker failed"),
              result,
            );
    }
  }
  // Cancellation can retire the worker before an accepted write returns its failure.
  for (const [origin, failure] of hostErrors) {
    if (!restoredOrigins.has(origin)) {
      result = withSqliteWorkerCleanupFailure(
        toErrorObject(failure, "Usage cache host effect failed"),
        result,
      );
    }
  }
  return result;
}
