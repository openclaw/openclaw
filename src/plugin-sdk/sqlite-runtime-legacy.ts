import type { DatabaseSync } from "node:sqlite";
import type { Compilable, Kysely, QueryResult } from "kysely";
import * as queries from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase as openNativeDatabase } from "../infra/node-sqlite.js";
import * as transactions from "../infra/sqlite-transaction.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseWrite as withNativeWrite } from "../state/openclaw-agent-db-write.js";
import * as agents from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission as runNativeAdmission } from "../state/openclaw-agent-write-admission.js";

const legacy = {
  family: "sqlite-runtime-native-access",
  replacement: "openOpenClawAgentSqliteWorkerStoreV2 or the owning domain's awaited operations",
  compatibility:
    "Native SQL and callbacks retain their current completion and transaction ordering.",
} as const;

/** @deprecated Writable runtime handles use openOpenClawAgentSqliteWorkerStoreV2; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. Explicit readOnly inspection remains supported. */
function sdkOpenNodeSqliteDatabase(...args: Parameters<typeof openNativeDatabase>) {
  if (!args[1]?.readOnly) {
    warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.openNodeSqliteDatabase" });
  }
  return openNativeDatabase(...args);
}

/** @deprecated Use openOpenClawAgentSqliteWorkerStoreV2; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkOpenOpenClawAgentDatabase(
  ...args: Parameters<typeof agents.openOpenClawAgentDatabase>
) {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.openOpenClawAgentDatabase" });
  return agents.openOpenClawAgentDatabase(...args);
}

/** @deprecated Use openOpenClawAgentSqliteWorkerStoreV2; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkBorrowOpenClawAgentDatabase(options: OpenClawAgentDatabaseOptions) {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.borrowOpenClawAgentDatabase" });
  return agents.borrowOpenClawAgentDatabase(options);
}

/** @deprecated Use openOpenClawAgentSqliteWorkerStoreV2; callbacks stay on the host and are removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkWithOpenClawAgentDatabaseAsync<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.withOpenClawAgentDatabaseAsync" });
  return agents.withOpenClawAgentDatabaseAsync(options, operation, assertCurrent, signal);
}

/** @deprecated Use openOpenClawAgentSqliteWorkerStoreV2; callbacks stay on the host and are removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkWithOpenClawAgentDatabaseWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T,
  expectedDatabase?: DatabaseSync,
  signal?: AbortSignal,
): Promise<T> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.withOpenClawAgentDatabaseWrite" });
  return withNativeWrite(options, operation, expectedDatabase, signal);
}

/** @deprecated Use openOpenClawAgentSqliteWorkerStoreV2; native admission callbacks are removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkRunOpenClawAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: Parameters<typeof runNativeAdmission<T>>[1],
  reentrant?: boolean,
  timing?: Parameters<typeof runNativeAdmission<T>>[3],
  signal?: AbortSignal,
): Promise<T> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.runOpenClawAgentWriteAdmission" });
  return runNativeAdmission(options, run, reentrant, timing, signal);
}

/** @deprecated Use sqlite-worker-runtime.getNodeSqliteKysely inside a worker backend; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkGetNodeSqliteKysely<Database>(database: DatabaseSync): Kysely<Database> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.getNodeSqliteKysely" });
  return queries.getNodeSqliteKysely<Database>(database);
}

/** @deprecated Use sqlite-worker-runtime.executeSqliteQuerySync inside a worker backend; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkExecuteSqliteQuerySync<Row>(
  database: DatabaseSync,
  query: Compilable<Row>,
): QueryResult<Row> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.executeSqliteQuerySync" });
  return queries.executeSqliteQuerySync(database, query);
}

/** @deprecated Use sqlite-worker-runtime.executeSqliteQueryTakeFirstSync inside a worker backend; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkExecuteSqliteQueryTakeFirstSync<Row>(
  database: DatabaseSync,
  query: Compilable<Row>,
): Row | undefined {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.executeSqliteQueryTakeFirstSync" });
  return queries.executeSqliteQueryTakeFirstSync(database, query);
}

/** @deprecated Use sqlite-worker-runtime.iterateSqliteQuerySync inside a worker backend; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkIterateSqliteQuerySync<Row>(
  database: DatabaseSync,
  query: Compilable<Row>,
): IterableIterator<Row> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.iterateSqliteQuerySync" });
  return queries.iterateSqliteQuerySync(database, query);
}

/** @deprecated Use sqlite-worker-runtime.prepareSqliteQuerySync inside a worker backend; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkPrepareSqliteQuerySync<Params, Row = unknown>(
  database: DatabaseSync,
  build: Parameters<typeof queries.prepareSqliteQuerySync<Params, Row>>[1],
): (params: Params) => QueryResult<Row> {
  const execute = queries.prepareSqliteQuerySync(database, build);
  return (params) => {
    warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.prepareSqliteQuerySync" });
    return execute(params);
  };
}

/** @deprecated Use sqlite-worker-runtime.runSqliteImmediateTransactionSync inside a worker backend; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkRunSqliteImmediateTransactionSync<T>(
  database: DatabaseSync,
  operation: () => T,
  options?: transactions.SqliteTransactionOptions,
): T {
  warnPluginSdkDeprecation({
    ...legacy,
    method: "sqlite-runtime.runSqliteImmediateTransactionSync",
  });
  return transactions.runSqliteImmediateTransactionSync(database, operation, options);
}

/** @deprecated Use openOpenClawAgentSqliteWorkerStoreV2; native transaction callbacks are removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
function sdkRunSqliteImmediateTransaction<T>(
  database: DatabaseSync,
  prepare: () => Promise<(() => T) | undefined>,
  options?: transactions.SqliteTransactionOptions,
  admit?: (write: () => T) => T | Promise<T>,
): Promise<T | undefined> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.runSqliteImmediateTransaction" });
  return transactions.runSqliteImmediateTransaction(database, prepare, options, admit);
}

export {
  sdkOpenNodeSqliteDatabase as openNodeSqliteDatabase,
  sdkOpenOpenClawAgentDatabase as openOpenClawAgentDatabase,
  sdkBorrowOpenClawAgentDatabase as borrowOpenClawAgentDatabase,
  sdkWithOpenClawAgentDatabaseAsync as withOpenClawAgentDatabaseAsync,
  sdkWithOpenClawAgentDatabaseWrite as withOpenClawAgentDatabaseWrite,
  sdkRunOpenClawAgentWriteAdmission as runOpenClawAgentWriteAdmission,
  sdkGetNodeSqliteKysely as getNodeSqliteKysely,
  sdkExecuteSqliteQuerySync as executeSqliteQuerySync,
  sdkExecuteSqliteQueryTakeFirstSync as executeSqliteQueryTakeFirstSync,
  sdkIterateSqliteQuerySync as iterateSqliteQuerySync,
  sdkPrepareSqliteQuerySync as prepareSqliteQuerySync,
  sdkRunSqliteImmediateTransactionSync as runSqliteImmediateTransactionSync,
  sdkRunSqliteImmediateTransaction as runSqliteImmediateTransaction,
};
