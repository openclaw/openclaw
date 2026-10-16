import type { PostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { SqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";
import type { StateDatabaseBorrowers } from "./openclaw-state-db-borrow.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseLifecycleEvent,
  StateDatabaseHandle,
} from "./openclaw-state-db-contract.js";

export type CachedOpenClawStateDatabase = OpenClawStateDatabase & {
  schemaFacts: SqliteSchemaFacts | PostgresPhysicalFacts | undefined;
};

export type StateDatabaseLifecycle = {
  cachedDatabases: Map<string, CachedOpenClawStateDatabase>;
  retainedDatabaseHandles: Map<EngineConnection, StateDatabaseHandle>;
  idleTimers: WeakMap<EngineConnection, ReturnType<typeof setTimeout>>;
  idleReferences: WeakMap<EngineConnection, Set<object>>;
  unregisterRetainedExitClose?: () => void;
  databaseIdentities: WeakMap<EngineConnection, DatabasePathIdentity>;
  borrowers: WeakMap<EngineConnection, StateDatabaseBorrowers>;
  databaseLifecycleListeners: Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>;
  terminalOpenLatch: ReturnType<typeof createSqliteTerminalOpenLatch>;
  asyncResources: ReturnType<typeof createOpenClawStateDatabaseAsyncLifecycle>;
};
