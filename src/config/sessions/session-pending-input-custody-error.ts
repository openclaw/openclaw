import type { TurnRecoveryIntent } from "./main-session-recovery.types.js";

/** Custody refusal must not release already accepted input for another dispatch. */
export class SessionPendingInputCustodyError extends Error {
  constructor(
    message: string,
    readonly assertCurrentTurn?: (intent: TurnRecoveryIntent) => void,
  ) {
    super(message);
  }
}
