/**
 * Thrown when a transcript read crosses the current-turn admission fence, such as a
 * stored cursor that already passed the admitted user message during bootstrap or assembly.
 */
export class SessionTranscriptReadFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptReadFenceError";
  }
}
