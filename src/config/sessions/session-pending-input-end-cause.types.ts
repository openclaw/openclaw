export type SessionPendingInputEndCause =
  | "user-stop"
  | "delete"
  | "reset"
  | "revoked"
  | "restart-unrecoverable"
  | "overflow"
  | "policy-refused"
  | "failed";
