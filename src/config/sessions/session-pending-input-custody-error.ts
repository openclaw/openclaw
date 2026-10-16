/** Custody refusal must not release already accepted input for another dispatch. */
export class SessionPendingInputCustodyError extends Error {}

/** A key already belongs to different input; retrying cannot repair this conflict. */
export class SessionPendingInputConflictError extends SessionPendingInputCustodyError {
  readonly code = "SESSION_INPUT_IDEMPOTENCY_CONFLICT";
}
