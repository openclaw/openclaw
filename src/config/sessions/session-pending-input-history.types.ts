import type { SessionPendingInputRow } from "./session-pending-input.types.js";
import type { InternalSessionEntry, PersistedSessionRunStatus } from "./types.js";

export type PendingInputHistoryRunState = Pick<InternalSessionEntry, "lastRunId" | "status">;

export type PendingInputHistoryTerminalCheck = (
  runId: string,
  status: PersistedSessionRunStatus,
) => boolean;

export type PendingInputHistoryQuery = {
  sessionKey: string;
  sessionId: string;
  limit?: number;
  before?: number;
  id?: string;
  includeTotal?: false;
  includeQueueObservation?: true;
  /** Replay only durable queued inputs that have no current process scheduler. */
  queuedOnly?: true;
  liveInputIds?: readonly string[];
  audience?: import("./session-pending-input-audience.js").PendingInputAudience;
};
export type PendingInputHistorySnapshot = {
  rows: SessionPendingInputRow[];
  total: number | undefined;
  hasQueuedInput?: boolean;
  runState?: PendingInputHistoryRunState;
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
