import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import type { WorkerEnvironmentStore } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";

export function createWorkerEnvironmentErrorRecorder(
  store: Pick<WorkerEnvironmentStore, "recordError">,
) {
  return async (record: WorkerEnvironmentRecord, error: unknown, assertCurrent?: () => void) => {
    assertCurrent?.();
    // Preserve the terminal cause and forced-discard intent across transient cleanup failures.
    if (
      (record.teardownTerminalState === "failed" && record.lastError) ||
      (record.destroyRequestedAtMs !== null && record.lastError === FORCED_WORKER_ABANDONMENT_ERROR)
    ) {
      return record;
    }
    return store.recordError({
      environmentId: record.environmentId,
      state: record.state,
      error: boundedWorkerError(error),
      assertCurrent,
    });
  };
}
