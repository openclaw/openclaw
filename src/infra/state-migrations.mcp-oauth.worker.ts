import type { DatabaseSync } from "node:sqlite";
import { parseMcpOAuthStoreJson } from "../agents/mcp-oauth-store.kernel.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import type {
  LegacyMcpOAuthImportResult,
  PreparedLegacyMcpOAuthImport,
} from "./state-migrations.mcp-oauth.worker-contract.js";
import {
  markLegacyMigrationSourceRemovedInDatabase,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

type McpOAuthMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "mcp_oauth_stores">;
const MIGRATION_KIND = "legacy-mcp-oauth-json";

function importAndRecordReceiptInDatabase(
  db: DatabaseSync,
  params: PreparedLegacyMcpOAuthImport,
): LegacyMcpOAuthImportResult {
  const { sourceKey, storeKey, now } = params;
  const runId = `${sourceKey}:${params.sourceSha256.slice(0, 16)}`;
  const stateDb = getNodeSqliteKysely<McpOAuthMigrationDatabase>(db);
  const existingReceipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
  if (existingReceipt) {
    return { sourceKey, imported: false };
  }

  const existingStore = executeSqliteQueryTakeFirstSync(
    db,
    stateDb.selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
  );
  let importedLegacyState: boolean;
  if (existingStore) {
    if (existingStore.format_version !== 1) {
      throw new Error("canonical MCP OAuth store has an unsupported format version");
    }
    const canonicalStore = parseMcpOAuthStoreJson(storeKey, existingStore.store_json);
    const canMergeLegacyState = canonicalStore.credentialState === "uninitialized";
    const legacyStore = { ...params.store };
    if (canonicalStore.pendingAuthorizationChallenge?.resourceMetadataUrl) {
      delete legacyStore.discoveryState;
    }
    importedLegacyState =
      canMergeLegacyState &&
      Object.keys(legacyStore).some((key) => !Object.hasOwn(canonicalStore, key));
    if (importedLegacyState) {
      const mergedStore = { ...legacyStore, ...canonicalStore };
      delete mergedStore.credentialState;
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("mcp_oauth_stores")
          .set({
            store_json: JSON.stringify(mergedStore),
            updated_at: now,
          })
          .where("store_key", "=", storeKey),
      );
    }
  } else {
    importedLegacyState = true;
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("mcp_oauth_stores").values({
        store_key: storeKey,
        format_version: 1,
        store_json: JSON.stringify(params.store),
        updated_at: now,
      }),
    );
  }

  const verified = executeSqliteQueryTakeFirstSync(
    db,
    stateDb.selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
  );
  if (!verified || verified.format_version !== 1) {
    throw new Error("SQLite verification failed for an MCP OAuth store");
  }
  parseMcpOAuthStoreJson(storeKey, verified.store_json);

  const reportJson = JSON.stringify({
    source: MIGRATION_KIND,
    target: "mcp_oauth_stores",
    storeKey,
    sourceSha256: params.sourceSha256,
    importedRecordCount: importedLegacyState ? 1 : 0,
    preservedSqliteRecordCount: existingStore ? 1 : 0,
  });
  recordLegacyMigrationReceipt(db, {
    sourceKey,
    migrationKind: MIGRATION_KIND,
    sourcePath: params.sourcePath,
    targetTable: "mcp_oauth_stores",
    sourceSha256: params.sourceSha256,
    sourceSizeBytes: params.sourceSizeBytes,
    sourceRecordCount: 1,
    runId,
    now,
    reportJson,
  });
  return { sourceKey, imported: importedLegacyState };
}

/** Doctor's original maintenance owner authorizes this separate migration family. */
function migrationWrite<Input, Result>(
  operation: (db: DatabaseSync, input: Input) => Result,
  recordReceipt?: (db: DatabaseSync, result: Result) => void,
) {
  return (input: Input, { open }: WorkerOperationContext): Result => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = operation(db, input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        recordReceipt?.(db, result);
        return result;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    );
  };
}

export const legacyMcpOAuthOperations = {
  "legacyMcpOAuth.readReceipt": (input: { sourceKey: string }, { open }) =>
    readLegacyMigrationReceiptFromDatabase(open().db, input.sourceKey),
  "legacyMcpOAuth.import": migrationWrite(
    importAndRecordReceiptInDatabase,
    deferSqliteWorkerCommitReceipt,
  ),
  "legacyMcpOAuth.markRemoved": migrationWrite((db, input: { sourceKey: string }): void => {
    markLegacyMigrationSourceRemovedInDatabase(db, input.sourceKey);
  }),
} satisfies WorkerOperationHandlers;

export type LegacyMcpOAuthWorkerOperations = WorkerOperations<typeof legacyMcpOAuthOperations>;
