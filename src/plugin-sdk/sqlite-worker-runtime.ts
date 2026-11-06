// SQLite backends use native primitives without loading host database lifecycle owners.
import type { DatabaseSync } from "node:sqlite";
import type { PostgresSqlConnection } from "../infra/sql-connection.js";
import {
  runSqliteDeferredTransactionSync as runDeferredTransaction,
  runSqliteImmediateTransactionSync as runImmediateTransaction,
  runSqliteReadSnapshotSync as runReadSnapshot,
  runSqliteSingleStatementSync as runSingleStatement,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { ensureOpenClawAgentStandingIntentsSchema as ensureStandingIntentsSchema } from "../state/openclaw-agent-standing-intents-schema.js";

type SyncReturnGuard<Result> = [Extract<Result, PromiseLike<unknown>>] extends [never]
  ? unknown
  : never;

export type SynchronousSqliteCallback<Result> = () => Result & NoInfer<SyncReturnGuard<Result>>;

export type SqliteWorkerTransactionOptions<CommitResult = void> = Omit<
  SqliteTransactionOptions,
  "withCommit"
> & {
  withCommit?: ((commit: () => void) => CommitResult) & NoInfer<SyncReturnGuard<CommitResult>>;
};

type WorkerTransaction = <Result, CommitResult = void>(
  database: DatabaseSync | PostgresSqlConnection,
  operation: SynchronousSqliteCallback<Result>,
  options?: SqliteWorkerTransactionOptions<CommitResult>,
) => Result;

type WorkerSchemaEnsure = <Result = void>(
  database: DatabaseSync,
  transact?: ((install: () => void) => Result) & NoInfer<SyncReturnGuard<Result>>,
) => void;

// Private worker callbacks reject inferred thenables without changing released
// SDK signatures. Keep the native function identities and runtime erasure guards.
export const runSqliteDeferredTransactionSync: WorkerTransaction = runDeferredTransaction;
export const runSqliteImmediateTransactionSync: WorkerTransaction = runImmediateTransaction;
export const runSqliteReadSnapshotSync: WorkerTransaction = runReadSnapshot;
export const runSqliteSingleStatementSync: <Result>(
  database: DatabaseSync | PostgresSqlConnection,
  statement: SynchronousSqliteCallback<Result>,
) => Result = runSingleStatement;

// The schema owner only passes its synchronous void installer to transact.
export const ensureOpenClawAgentStandingIntentsSchema =
  // SAFETY: Narrow only that private producer; its released generic signature stays intact.
  ensureStandingIntentsSchema as WorkerSchemaEnsure;

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
export type { SqlConnection } from "../infra/sql-connection.js";
export { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
export {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabasePendingWriteToken,
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseWriteTokenForPath,
  withSqliteDatabaseWriteScope,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
export { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
export { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
export { assertTransactionUsable } from "../infra/sqlite-transaction.js";
export type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
  SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";
export { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
export { bindSqliteWorkerDatabase } from "../infra/sqlite-worker-binding.js";
export { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
export { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
export { stageOpenClawAgentDatabaseSchemaExtension } from "../state/openclaw-agent-db-schema-extension.worker.js";
