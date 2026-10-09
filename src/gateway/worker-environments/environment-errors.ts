import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import type { WorkerEnvironmentStore } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";

export type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_project"
  | "capacity"
  | "invalid_state"
  | "desktop_app_not_found"
  | "unsupported_platform"
  | "launcher_failure"
  | "provider_failure"
  | "bootstrap_failure";

export class WorkerEnvironmentServiceError extends Error {
  constructor(
    readonly code: WorkerEnvironmentServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const workerEnvironmentServiceError = (
  code: WorkerEnvironmentServiceErrorCode,
  message: string,
) => new WorkerEnvironmentServiceError(code, message);

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
