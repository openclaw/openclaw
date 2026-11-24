import type { SessionPendingInputRow } from "./session-pending-input.types.js";

export type PendingInputHistoryQuery = {
  sessionKey: string;
  sessionId: string;
  limit?: number;
  before?: number;
  id?: string;
  includeTotal?: false;
  /** Replay only durable queued inputs that have no current process scheduler. */
  queuedOnly?: true;
  liveInputIds?: readonly string[];
};
export type PendingInputHistorySnapshot = {
  rows: SessionPendingInputRow[];
  total: number | undefined;
  nextBefore?: number;
  currentSessionId?: string;
};
export type PendingInputHistoryWorkerInput = {
  kind: "session-pending-input-history";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  query: PendingInputHistoryQuery;
  source: import("./session-entry-read-source.types.js").CapturedSessionEntryReadSource;
};

export type PendingInputOrphansWorkerInput = Omit<
  PendingInputHistoryWorkerInput,
  "kind" | "query"
> & {
  kind: "session-pending-input-orphans";
  lifecycleGeneration: string;
};
export type PendingInputOrphanTarget = { sessionKey: string; sessionId: string };
