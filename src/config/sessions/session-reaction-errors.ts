export class SessionReactionLimitError extends Error {
  constructor() {
    super("reaction limit reached");
    this.name = "SessionReactionLimitError";
  }
}

/** The message was deleted between the caller's asynchronous read and this transaction. */
export class SessionReactionMessageMissingError extends Error {
  constructor() {
    super("unknown message");
    this.name = "SessionReactionMessageMissingError";
  }
}
