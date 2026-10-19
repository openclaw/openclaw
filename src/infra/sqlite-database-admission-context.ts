// Admission transport and task scope do not need native connection validation or publication logging.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  SqliteDatabaseAdmissionRegistry,
  readSqliteDatabaseAdmissions,
  type Admission,
  type SqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissionExchange as Exchange,
  type StagedAdmissionFact,
} from "./sqlite-database-admission-record.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sqliteDatabaseAdmissions"), () => ({
  registry: new SqliteDatabaseAdmissionRegistry(),
  connections: new WeakMap<DatabaseSync, Admission>(),
  openedIdentities: new WeakMap<DatabaseSync, string>(),
  unproven: new WeakSet<DatabaseSync>(),
  suspended: new WeakSet<DatabaseSync>(),
  local: new WeakMap<DatabaseSync, Map<string, StagedAdmissionFact>>(),
  rolledBack: new WeakSet<DatabaseSync>(),
  dataWriters: new WeakMap<DatabaseSync, Admission | undefined>(),
  localWriteRevisions: new WeakMap<DatabaseSync, number>(),
  writeListeners: new WeakMap<Admission, Set<() => void>>(),
  ddlRevisions: new WeakMap<DatabaseSync, number>(),
  schemaDirty: new WeakSet<DatabaseSync>(),
  localSchemaRevisions: new Map<string, number>(),
  misses: new WeakMap<Admission, Map<string, number>>(),
  exchange: new AsyncLocalStorage<Exchange>(),
  exchanging: false,
  publication: 0,
}));

export { state as sqliteDatabaseAdmissionState };

export function captureSqliteDatabaseAdmissions(
  cursor?: SqliteDatabaseAdmissionCursor,
  scope?: { location?: string; admissions?: SqliteDatabaseAdmissions },
): SqliteDatabaseAdmissions {
  return state.registry.capture(cursor, scope);
}

export function installSqliteDatabaseAdmissions(admissions: SqliteDatabaseAdmissions): void {
  state.registry.install(admissions);
}

export function withSqliteDatabaseAdmissionExchange<T>(
  exchangeOwner: Exchange,
  operation: () => T,
): T {
  return state.exchange.run(exchangeOwner, operation);
}

/** Unsupported worker hosts retain native validation instead of waiting for unpublished facts. */
export function canShareSqliteDatabaseAdmissions(): boolean {
  return threadId === 0 || state.exchange.getStore() !== undefined;
}

const inherited = readSqliteDatabaseAdmissions(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY));
if (inherited) {
  installSqliteDatabaseAdmissions(inherited);
  // The parent already owns the snapshot inherited by this Worker.
  state.registry.captureExchange();
}
