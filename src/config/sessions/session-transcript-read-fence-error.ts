export class SessionTranscriptReadFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptReadFenceError";
  }
}
