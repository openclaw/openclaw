import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";

export const STATE_CONTENTION_SUMMARY =
  "The turn was interrupted while the server was busy. Check its status before trying again.";

export const STATE_CONTENTION_DIAGNOSTIC =
  "SQLite transaction admission remained busy. Execution may have occurred; check the recorded outcome before resending.";

/** Presentation is not replay authority. Only the direct typed failure is classified. */
export function resolveStateContentionPresentation(error: unknown) {
  return isSqliteLockError(error)
    ? {
        errorKind: "state_contention" as const,
        errorMessage: `${STATE_CONTENTION_SUMMARY}\n\n${STATE_CONTENTION_DIAGNOSTIC}`,
      }
    : undefined;
}
