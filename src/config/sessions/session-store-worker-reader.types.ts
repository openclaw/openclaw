import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { PreparedSessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

export type SessionStoreWorkerReader = {
  reader: SessionHistoryWorkerDatabase;
  database: PreparedSessionEntryWorkerRead["database"];
  logicalAgentId: string;
  selectedStore: Readonly<{ path: string; physicalPath: string }>;
  continuation?: CanonicalSessionReaderContinuation;
  assertCurrent: () => void;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  refreshBeforeDispatch?: (assertRetainedTarget: () => void) => Promise<void>;
  revalidateTarget?: () => Promise<void>;
};
