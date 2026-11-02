import type { readSqliteDatabaseScopedWriteToken } from "../../infra/sqlite-database-admission.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-projection-append.js";

/** Complete eligible metadata for a bounded, boundary-free active path. No event bodies. */
export type SessionTranscriptContextMetadata = {
  header: { seq: number; navigation_valid: number; serialized_bytes: number } | undefined;
  rows: Array<{ event_seq: number; active_position: number; serialized_bytes: number }>;
  boundaryCount: 0;
  eventCount: number;
  sizeBytes: number;
};

/** Exact context totals; the actor updates these independently of its bounded row window. */
export type SessionTranscriptContextStats = {
  eventCount: number;
  sizeBytes: number;
  boundaryActivePosition: number;
};

/** Small projection metadata; transcript bodies stay with the history reader. */
export type SessionTranscriptProjectionFacts = {
  cold: boolean;
  generation: string | undefined;
  updatedAt: number | null;
  hasUnclassified: boolean;
  latestIndexedReset: {
    active_position: number;
    event_id: string;
    event_type: "reset";
    seq: number;
  } | null;
  hasUnindexedPrefix: boolean;
  latestSeq: number | null;
  state?: SessionTranscriptProjectionState;
  contextMetadata?: SessionTranscriptContextMetadata;
};

export type SessionTranscriptProjectionReceipt = {
  sessionId: string;
  /** The actor snapshot validated this entry independently of transcript-window completeness. */
  entrySessionKey?: string;
  writeToken: string;
  writeScopes: Parameters<typeof readSqliteDatabaseScopedWriteToken>[1];
  facts?: SessionTranscriptProjectionFacts;
  contextStats?: SessionTranscriptContextStats;
  contextStatsVersion?: SessionTranscriptContextVersion;
  /** Accounting borrows totals only when its native snapshot matches contextStatsVersion. */
  contextOnly?: boolean;
};
