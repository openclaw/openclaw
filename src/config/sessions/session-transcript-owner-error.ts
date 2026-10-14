/** A transcript write named a session key other than the one owning that transcript. */
export class SessionTranscriptOwnerMismatchError extends Error {
  constructor(
    readonly sessionId: string,
    readonly ownerSessionKey: string,
    readonly requestedSessionKey: string,
  ) {
    super(
      `Transcript session ${sessionId} is owned by ${ownerSessionKey}, not ${requestedSessionKey}; resolve the transcript target again before retrying.`,
    );
    this.name = "SessionTranscriptOwnerMismatchError";
  }
}
