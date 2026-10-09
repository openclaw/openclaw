import type { SessionSourceValidation } from "./session-source-authority.js";
import type { TranscriptAppendRefusal } from "./session-transcript-writer-claim-error.js";
import type { SqliteExpectedSessionTranscriptTurnResult } from "./session-turn.types.js";

export type SessionColdMutationResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
  restored: boolean;
  sessionKey?: string;
  turnRebound?: SqliteExpectedSessionTranscriptTurnResult;
  refusedSource?: NonNullable<SessionSourceValidation["refusedSource"]>;
  writerRefusal?: TranscriptAppendRefusal;
};
