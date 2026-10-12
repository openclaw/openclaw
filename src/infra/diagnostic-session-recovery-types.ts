/**
 * Outcome published on `session.recovery.completed`. `force_cleared` is not an
 * `aborted` variant: it reclaims a lane whose owner never acknowledged the abort.
 */
export type DiagnosticSessionRecoveryStatus =
  | "aborted"
  | "force_cleared"
  | "released"
  | "skipped"
  | "noop"
  | "failed";
