export type TranscriptAppendRefusal =
  | {
      actualSessionIdHash: string;
      agentIdHash: string;
      code: "session-rebound";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    }
  | {
      agentIdHash: string;
      code: "session-entry-missing";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    };

export class SessionTranscriptWriterClaimReboundError extends Error {
  constructor(cause?: TranscriptAppendRefusal) {
    super("session writer claim changed before transcript persistence", { cause });
    this.name = "SessionTranscriptWriterClaimReboundError";
  }
}
