import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import type { WorkerEnvironmentStore } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";

const FORCED_ABANDONMENT_DIAGNOSTIC_PREFIX = `${FORCED_WORKER_ABANDONMENT_ERROR}; `;

export function hasForcedWorkerEnvironmentAbandonment(
  record: Pick<WorkerEnvironmentRecord, "destroyRequestedAtMs" | "lastError">,
): boolean {
  return (
    record.destroyRequestedAtMs !== null &&
    (record.lastError === FORCED_WORKER_ABANDONMENT_ERROR ||
      record.lastError?.startsWith(FORCED_ABANDONMENT_DIAGNOSTIC_PREFIX) === true)
  );
}

export function createWorkerEnvironmentErrorRecorder(
  store: Pick<WorkerEnvironmentStore, "recordError">,
) {
  return async (record: WorkerEnvironmentRecord, error: unknown, assertCurrent?: () => void) => {
    assertCurrent?.();
    // Preserve the original terminal failure; forced discard can carry the latest cleanup error.
    if (record.teardownTerminalState === "failed" && record.lastError) {
      return record;
    }
    return store.recordError({
      environmentId: record.environmentId,
      state: record.state,
      error: hasForcedWorkerEnvironmentAbandonment(record)
        ? `${FORCED_ABANDONMENT_DIAGNOSTIC_PREFIX}${boundedWorkerError(error, 1_024 - FORCED_ABANDONMENT_DIAGNOSTIC_PREFIX.length)}`
        : boundedWorkerError(error),
      assertCurrent,
    });
  };
}
