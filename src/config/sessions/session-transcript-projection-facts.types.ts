import type { readSqliteDatabaseScopedWriteToken } from "../../infra/sqlite-database-admission.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-projection-append.js";

/** Small projection metadata; transcript bodies stay with the history reader. */
export type SessionTranscriptProjectionFacts = {
  cold: boolean;
  generation: string | undefined;
  updatedAt: number | null;
  hasUnclassified: boolean;
  latestIndexedReset: { active_position: number; event_type: "reset"; seq: number } | null;
  hasUnindexedPrefix: boolean;
  latestSeq: number | null;
  state?: SessionTranscriptProjectionState;
};

export type SessionTranscriptProjectionReceipt = {
  path: string;
  sessionId: string;
  writeToken: string;
  writeScopes: Parameters<typeof readSqliteDatabaseScopedWriteToken>[1];
  facts: SessionTranscriptProjectionFacts;
};
