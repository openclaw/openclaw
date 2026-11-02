import type { SessionPendingInputRow } from "./session-pending-input.types.js";

export type PendingInputHistoryQuery = {
  sessionKey: string;
  sessionId: string;
  limit?: number;
  before?: number;
  id?: string;
  includeTotal?: false;
  /** Exact custody captured in a committed graceful-shutdown marker. */
  queuedInputIds?: readonly string[];
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
  queuedInputIds: readonly string[];
};
export type PendingInputOrphanTarget = { sessionKey: string; sessionId: string };
