// Worker error transport must not load the cold-storage database implementation.
export class SessionTranscriptColdError extends Error {
  readonly code = "TRANSCRIPT_COLD";
  constructor(readonly sessionId = "") {
    super(
      `Transcript${sessionId ? ` ${sessionId}` : ""} is in cold storage. Restore its archive before reading or changing the transcript.`,
    );
    this.name = "SessionTranscriptColdError";
  }
}
