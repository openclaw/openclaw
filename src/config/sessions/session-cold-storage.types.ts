import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import type { TranscriptAppendRefusal } from "./session-transcript-writer-claim-error.js";
import type { SqliteExpectedSessionTranscriptTurnResult } from "./session-turn.types.js";

export type SessionColdPlan = {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};
export type SessionColdPrepared = {
  plan: SessionColdPlan;
  archive: SessionColdArchive;
  envelopeBytes: number;
};
export type SessionColdExternalization = {
  archive: Omit<SessionColdArchive, "archive_blob">;
  envelopeBytes: number;
};

export type SessionColdMutationResult = {
  transcriptPublication?: readonly import("./session-transcript-authority.js").SessionTranscriptAuthorityReceipt[];
  archivedTranscripts: number;
  externalizedTranscripts: number;
  restored: boolean;
  sessionKey?: string;
  turnRebound?: SqliteExpectedSessionTranscriptTurnResult;
  refusedSource?: NonNullable<SessionSourceValidation["refusedSource"]>;
  writerRefusal?: TranscriptAppendRefusal;
};

export type SessionColdMaintenanceResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
};

export type SessionColdBatchOptions = {
  databaseOptions: OpenClawAgentDatabaseOptions;
  ownerStorePath: string;
  beforeMs: number;
  maxTranscripts: number;
  maxBytes: number;
  assertCurrent?: () => void;
};

export type SessionColdBatchResult = SessionColdMaintenanceResult & {
  envelopeBytes: number;
  attemptedTranscripts: number;
};
