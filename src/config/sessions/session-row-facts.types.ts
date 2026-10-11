import type { SessionAccessScope, SessionEntrySummary } from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";

/** Exact database facts shared by durable row readers and the incognito actor. */
export type SessionRowDatabaseFacts = SessionEntrySummary & {
  hasBoard: boolean;
  activitySummaryWatermark?: SessionTranscriptWatermark;
};

export type SessionRowFactsWorkerInput = {
  kind: "session-row-facts";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  sessionKeys: readonly string[];
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionRowFactsWorkerResult = {
  kind: "session-row-facts";
  rows: SessionRowDatabaseFacts[];
};

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};
