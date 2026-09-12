import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  assertSqliteIntegrity,
  SqliteRepairableForeignKeyError,
} from "../infra/sqlite-integrity.js";
import {
  assertSqliteSchemaContains,
  getCanonicalSqliteTableNames,
  readSqliteSchemaCookie,
} from "../infra/sqlite-schema-contract.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { withStateSchemaFence } from "../infra/state-database-coordinator.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { recoverOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery.js";
import {
  runCoordinatedStateTransaction,
  withSharedStateWriteCoordinator,
} from "./openclaw-state-db-write-coordination.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowed,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";

/** Validate only the stable storage subset used by an existing-schema owner.
 * This read neither repairs nor grants write authority; callers retain their
 * actual handle, generation, lease and publication checks. */
function assertExistingOpenClawStateSchema(
  db: DatabaseSync,
  pathname: string,
  schemaSql: string,
): number {
  const version = assertSupportedStateSchemaVersion(db, pathname);
  assertOpenClawStateDatabaseOwner(db, { pathname });
  const metadata = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "schema_meta">>(db)
      .selectFrom("schema_meta")
      .select("schema_version")
      .where("meta_key", "=", "primary"),
  );
  if (version < 1 || metadata?.schema_version !== version) {
    throw new Error("Existing-state schema metadata is inconsistent.");
  }
  assertSqliteIntegrity(db, pathname);
  assertSqliteSchemaContains(db, pathname, schemaSql);
  return version;
}

/** A synchronous write to an already-compatible, caller-owned schema subset.
 * No database bootstrap, schema repair, journal-mode setup, cached publication or WAL timer.
 * First-use owners may install their declared additive tables; existing objects
 * must already match. This never opens or migrates the full runtime schema.
 * The real handle and write coordinators cover open, transaction, and close.
 */
export function runExistingOpenClawStateWriteTransaction<T>(
  operation: (database: { db: DatabaseSync; path: string; recoveryChanges: string[] }) => T,
  options: OpenClawStateDatabaseOptions,
  contract: {
    schemaSql: string;
    operationLabel: string;
    busyTimeoutMs?: number;
    initializeAdditiveSchema?: boolean;
    recoverTaskDeliveryOrphans?: true;
  },
): T {
  if (options.database || options.readOnly) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const env = options.env ?? process.env;
  const busyTimeoutMs = contract.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS;
  const pathname = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(env));
  const original = fs.lstatSync(pathname);
  if (!original.isFile()) {
    throw new Error("Existing-state write requires a regular database file.");
  }
  const assertSameFile = () => {
    const current = fs.lstatSync(pathname);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Existing-state database generation changed.");
    }
  };
  const write = () =>
    withSharedStateWriteCoordinator({ databasePath: pathname, busyTimeoutMs }, () =>
      runWithOpenClawStateWriteAccess(
        { databasePath: pathname, env, busyTimeoutMs },
        contract.operationLabel,
        () => {
          assertSameFile();
          openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
            pathname,
            env,
          );
          const db = openTrackedStateDatabase(pathname, {
            existingOnly: true,
            // Match Doctor: inbound dependents must fail validation, never cascade away.
            ...(contract.recoverTaskDeliveryOrphans ? { enableForeignKeyConstraints: false } : {}),
          });
          try {
            setSqliteBusyTimeout(db, busyTimeoutMs);
            return runCoordinatedStateTransaction(
              db,
              () => {
                assertSameFile();
                assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
                const validate = () =>
                  assertExistingOpenClawStateSchema(
                    db,
                    pathname,
                    contract.initializeAdditiveSchema ? "" : contract.schemaSql,
                  );
                let version: number;
                let recoveryChanges: string[] = [];
                try {
                  version = validate();
                } catch (error) {
                  if (
                    !contract.recoverTaskDeliveryOrphans ||
                    !(error instanceof SqliteRepairableForeignKeyError)
                  ) {
                    throw error;
                  }
                  recoveryChanges = recoverOrphanTaskDeliveryRows(db, pathname);
                  version = validate();
                }
                if (contract.initializeAdditiveSchema) {
                  // Validate present objects before first use: CREATE IF NOT EXISTS
                  // must not hide drift or repair an incomplete existing table.
                  assertSqliteSchemaContains(db, pathname, contract.schemaSql, {
                    allowedMissingTables: getCanonicalSqliteTableNames(contract.schemaSql),
                  });
                  db.exec(contract.schemaSql); // sqlite-allow-raw -- Declared canonical feature-local additive DDL only.
                  assertSqliteSchemaContains(db, pathname, contract.schemaSql);
                }
                const schemaVersion = readSqliteSchemaCookie(db);
                const result = operation({ db, path: pathname, recoveryChanges });
                assertSameFile();
                if (
                  readSqliteUserVersion(db) !== version ||
                  readSqliteSchemaCookie(db) !== schemaVersion
                ) {
                  throw new Error("Existing-state transaction cannot migrate schema.");
                }
                if (contract.recoverTaskDeliveryOrphans) {
                  assertSqliteIntegrity(db, pathname);
                }
                return result;
              },
              {
                busyTimeoutMs,
                databaseLabel: pathname,
                operationLabel: contract.operationLabel,
              },
            );
          } finally {
            clearNodeSqliteKyselyCacheForDatabase(db);
            closeTrackedStateDatabase(db);
          }
        },
      ),
    );
  return contract.recoverTaskDeliveryOrphans
    ? withStateSchemaFence({ databasePath: pathname }, write)
    : write();
}
