export class SessionEntryChangedDuringReadError extends Error {
  constructor() {
    super("Session entry changed during read");
    this.name = "SessionEntryChangedDuringReadError";
  }
}
