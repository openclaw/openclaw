// SQLite backends use native primitives without loading host database lifecycle owners.
export type { Generated, Selectable } from "kysely";
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
export {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";
export { PostgresSyncConnection } from "../infra/postgres-sync/connection.js";
export type { SqlConnection } from "../infra/sql-connection.js";
export {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  readSqliteDatabasePendingWriteToken,
  readSqliteDatabaseWriteTokenForPath,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
export { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
export { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
export {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
  runSqliteSingleStatementSync,
} from "../infra/sqlite-transaction.js";
export type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
  SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";
export { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
export { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
export { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
export { ensureOpenClawAgentStandingIntentsSchema } from "../state/openclaw-agent-standing-intents-schema.js";
