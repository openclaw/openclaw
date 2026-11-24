import {
  classifyGatewayStorageFailure,
  isSqliteLockError,
} from "../infra/sqlite-error-diagnostics.js";

export const STATE_CONTENTION_SUMMARY =
  "Your request was interrupted while the server was busy. Check its status before trying again.";

export const STATE_CONTENTION_DIAGNOSTIC =
  "SQLite transaction admission remained busy. Execution may have occurred; check the recorded outcome before resending.";

/** Run failures whose recovery a client presents differently from a generic failed reply. */
export type ChatRunErrorKind = "state_contention" | "storage_worker_memory";

/** Presentation is not replay authority. Only the direct typed failure is classified. */
export function resolveStateContentionPresentation(error: unknown) {
  return isSqliteLockError(error)
    ? {
        errorKind: "state_contention" as const,
        errorMessage: `${STATE_CONTENTION_SUMMARY}\n\n${STATE_CONTENTION_DIAGNOSTIC}`,
      }
    : undefined;
}

/** A worker OOM repeats when the same conversation loads again; clients offer a new chat instead. */
export function resolveChatRunErrorKind(error: unknown): ChatRunErrorKind | undefined {
  return (
    resolveStateContentionPresentation(error)?.errorKind ??
    (classifyGatewayStorageFailure(error) === "storage-worker-memory"
      ? "storage_worker_memory"
      : undefined)
  );
}
