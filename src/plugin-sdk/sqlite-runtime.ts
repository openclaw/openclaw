// Narrow SQLite schema, path, and transaction helpers for first-party runtime.

export type { Generated, Selectable } from "kysely";
export {
  openSqliteWorkerStore,
  SqliteWorkerError,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";

export {
  borrowOpenClawAgentDatabase,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
export { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
export { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
export { ensureOpenClawAgentStandingIntentsSchema } from "../state/openclaw-agent-standing-intents-schema.js";
export {
  compileSqliteQueryBindings,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
export { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
export {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
export {
  runSqliteImmediateTransaction,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
export { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
