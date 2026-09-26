import type { DatabaseSync } from "node:sqlite";
import type { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";
import type { StateDatabaseBorrowers } from "./openclaw-state-db-borrow.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseLifecycleEvent,
  StateDatabaseHandle,
} from "./openclaw-state-db-contract.js";

export type StateDatabaseLifecycle = {
  cachedDatabases: Map<string, OpenClawStateDatabase>;
  retainedDatabaseHandles: Map<DatabaseSync, StateDatabaseHandle>;
  idleTimers: WeakMap<DatabaseSync, ReturnType<typeof setTimeout>>;
  idleReferences: WeakMap<DatabaseSync, Set<object>>;
  unregisterRetainedExitClose?: () => void;
  databaseIdentities: WeakMap<DatabaseSync, DatabasePathIdentity>;
  borrowers: WeakMap<DatabaseSync, StateDatabaseBorrowers>;
  databaseLifecycleListeners: Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>;
  terminalOpenLatch: ReturnType<typeof createSqliteTerminalOpenLatch>;
  asyncResources: ReturnType<typeof createOpenClawStateDatabaseAsyncLifecycle>;
};
