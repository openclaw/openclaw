/** A read lost publication to newer state; no actor command was accepted. */
export class SessionActorReadInvalidatedError extends Error {
  constructor() {
    super("Session actor changed before its read could publish");
    this.name = "SessionActorReadInvalidatedError";
  }
}
