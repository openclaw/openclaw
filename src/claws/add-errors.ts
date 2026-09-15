// Thrown by a consented Claw add's apply-phase mutation on a recoverable-by-retry failure.
export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}
