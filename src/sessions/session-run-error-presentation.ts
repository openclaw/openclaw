import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator-errors.js";

export const STATE_CONTENTION_SUMMARY =
  "The turn was interrupted while the server was busy. Check its status before trying again.";

export const STATE_CONTENTION_DIAGNOSTIC =
  "StateDatabaseCoordinatorContentionError: state-lifecycle acquisition remained busy. Execution may have occurred; check the recorded outcome before resending.";

/** Presentation is not replay authority. Only the direct typed failure is classified. */
export function resolveStateContentionPresentation(error: unknown) {
  return error instanceof StateDatabaseCoordinatorContentionError &&
    error.family === "state-lifecycle"
    ? {
        errorKind: "state_contention" as const,
        errorMessage: `${STATE_CONTENTION_SUMMARY}\n\n${STATE_CONTENTION_DIAGNOSTIC}`,
      }
    : undefined;
}
