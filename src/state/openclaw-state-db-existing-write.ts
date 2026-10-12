import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  assertSqliteIntegrity,
  SqliteRepairableForeignKeyError,
} from "../infra/sqlite-integrity.js";
import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import {
  assertSqliteSchemaContains,
  getCanonicalSqliteTableNames,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import {
  assertTransactionUsable,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { withStateDatabaseSchemaMaintenance } from "../infra/state-database-maintenance.js";
import { createStateSchemaAdmission } from "./openclaw-state-db-admission.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { assertStateDatabaseIntegrityOnce } from "./openclaw-state-db-integrity-admission.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  assertOpenClawStateSchemaRepairAllowed,
  isExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { recoverOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery.js";
import { runManagedStateTransaction } from "./openclaw-state-db-transaction.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";

type ExistingWriteOptions = OpenClawStateDatabaseOptions & { busyTimeoutMs?: number };
type ExistingWriteContract = Pick<SqliteTransactionOptions, "beginLockFailureReporting"> & {
  schemaSql: string;
  schemaCompatibility?: SqliteSchemaCompatibility;
  operationLabel: string;
  busyTimeoutMs?: number;
};
type OneShotWriteContract = ExistingWriteContract & {
  initializeAdditiveSchema?: boolean;
  recoverTaskDeliveryOrphans?: true;
};
type ExistingWriteOperation<T> = (database: {
  db: DatabaseSync;
  path: string;
  recoveryChanges: string[];
}) => T;

export type ExistingOpenClawStateWriter = ReturnType<typeof createExistingOpenClawStateWriter>;

function assertExistingOpenClawStateSchemaMetadata(
  db: DatabaseSync,
  pathname: string,
  version: number,
): void {
  const metadata = assertOpenClawStateDatabaseOwner(db, { pathname });
  if (version < 1 || metadata?.schema_version !== version) {
    throw new Error("Existing-state schema metadata is inconsistent.");
  }
}

/** Validate only the stable storage subset used by an existing-schema owner.
 * This read neither repairs nor grants write authority; callers retain their
 * actual handle, generation, lease and publication checks. */
function assertExistingOpenClawStateSchema(
  db: DatabaseSync,
  pathname: string,
  schemaSql: string,
  compatibility?: SqliteSchemaCompatibility,
): number {
  const version = assertSupportedStateSchemaVersion(db, pathname);
  assertExistingOpenClawStateSchemaMetadata(db, pathname, version);
  assertStateDatabaseIntegrityOnce(db, pathname);
  assertSqliteSchemaContains(db, pathname, schemaSql, compatibility);
  return version;
}

/** A synchronous write to an already-compatible, caller-owned schema subset.
 * No database bootstrap, schema repair, journal-mode setup, cached publication or WAL timer.
 * First-use owners may install their declared additive tables; existing objects
 * must already match. This never opens or migrates the full runtime schema.
 * The admitted native connection owns transaction serialization.
 */
export function runExistingOpenClawStateWriteTransaction<T>(
  operation: ExistingWriteOperation<T>,
  options: OpenClawStateDatabaseOptions,
  contract: OneShotWriteContract,
): T {
  const prepared = prepareExistingOpenClawStateWriter(options, contract);
  const write = () => {
    const writer = createExistingOpenClawStateWriter(prepared, contract);
    try {
      return writer.run(operation, options);
    } finally {
      writer.close();
    }
  };
  return contract.recoverTaskDeliveryOrphans
    ? withStateDatabaseSchemaMaintenance({ databasePath: prepared.pathname }, write)
    : write();
}

/** Retain the admitted subset connection without bootstrapping the runtime schema. */
export function openExistingOpenClawStateWriter(
  options: OpenClawStateDatabaseOptions,
  contract: ExistingWriteContract,
): ExistingOpenClawStateWriter {
  return createExistingOpenClawStateWriter(
    prepareExistingOpenClawStateWriter(options, contract),
    contract,
  );
}

function prepareExistingOpenClawStateWriter(
  options: OpenClawStateDatabaseOptions,
  contract: OneShotWriteContract,
) {
  if (options.database || options.readOnly) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath({ path: options.path, env });
  isExistingOpenClawStateSchema(pathname);
  if (contract.recoverTaskDeliveryOrphans) {
    assertOpenClawStateSchemaRepairAllowed(pathname);
  }
  const original = fs.lstatSync(pathname);
  if (!original.isFile()) {
    throw new Error("Existing-state write requires a regular database file.");
  }
  return { env, pathname, original };
}

function createExistingOpenClawStateWriter(
  { env, pathname, original }: ReturnType<typeof prepareExistingOpenClawStateWriter>,
  contract: OneShotWriteContract,
) {
  const assertSameFile = () => {
    const current = fs.lstatSync(pathname);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Existing-state database generation changed.");
    }
  };
  assertSameFile();
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  const db = openTrackedStateDatabase(pathname, {
    existingOnly: true,
    // Match Doctor: inbound dependents must fail validation, never cascade away.
    ...(contract.recoverTaskDeliveryOrphans ? { enableForeignKeyConstraints: false } : {}),
  });
  const admission = createStateSchemaAdmission(
    `state.subset:${createHash("sha256")
      .update(JSON.stringify([contract.schemaSql, contract.schemaCompatibility]))
      .digest("hex")}`,
    (value) => (typeof value === "number" ? value : undefined),
  );
  let closed = false;
  return {
    run<T>(operation: ExistingWriteOperation<T>, currentOptions: ExistingWriteOptions) {
      if (closed || !db.isOpen) {
        throw new Error("Existing-state writer is closed.");
      }
      if (currentOptions.database || currentOptions.readOnly) {
        throw new Error("Existing-state writes require their own tracked writable connection.");
      }
      const currentEnv = currentOptions.env ?? process.env;
      if (resolveDatabasePath({ path: currentOptions.path, env: currentEnv }) !== pathname) {
        throw new Error("Existing-state writer cannot change its database path.");
      }
      assertSameFile();
      const existingSchema = isExistingOpenClawStateSchema(pathname);
      const busyTimeoutMs =
        currentOptions.busyTimeoutMs ?? contract.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS;
      setSqliteBusyTimeout(db, busyTimeoutMs);
      return runManagedStateTransaction(
        db,
        () => {
          assertSameFile();
          assertOpenClawStateWriteAllowed({
            database: db,
            databasePath: pathname,
            env: currentEnv,
          });
          const priorVersion = admission.get(db);
          const needsAdmission = priorVersion === undefined;
          if (existingSchema) {
            assertExistingOpenClawStateRuntimeSchema(db, pathname);
          }
          const validate = () =>
            assertExistingOpenClawStateSchema(
              db,
              pathname,
              needsAdmission && contract.initializeAdditiveSchema ? "" : contract.schemaSql,
              contract.schemaCompatibility,
            );
          let version: number;
          let recoveryChanges: string[] = [];
          if (priorVersion !== undefined) {
            version = priorVersion;
          } else {
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
          }
          if (needsAdmission && contract.initializeAdditiveSchema) {
            // Validate present objects before first use: CREATE IF NOT EXISTS
            // must not hide drift or repair an incomplete existing table.
            assertSqliteSchemaContains(db, pathname, contract.schemaSql, {
              ...contract.schemaCompatibility,
              allowedMissingTables: getCanonicalSqliteTableNames(contract.schemaSql),
            });
            db.exec(contract.schemaSql); // sqlite-allow-raw -- Declared canonical feature-local additive DDL only.
            assertSqliteSchemaContains(
              db,
              pathname,
              contract.schemaSql,
              contract.schemaCompatibility,
            );
          }
          if (needsAdmission) {
            admitSqliteSchema(db);
            admission.publish(db, version);
          }
          // Internal callers own their declared schema and only mutate its rows here.
          const value = operation({ db, path: pathname, recoveryChanges });
          assertSameFile();
          if (contract.recoverTaskDeliveryOrphans) {
            assertSqliteIntegrity(db, pathname);
          }
          return value;
        },
        {
          beginLockFailureReporting: contract.beginLockFailureReporting,
          busyTimeoutMs,
          databaseLabel: pathname,
          operationLabel: contract.operationLabel,
        },
      );
    },
    assertSettled() {
      assertSameFile();
      assertTransactionUsable(db);
      if (db.isOpen && db.isTransaction) {
        throw new Error("Existing-state writer retained an unsettled transaction");
      }
      if (db.isOpen) {
        assertNoActiveSqliteReaders(db, "Existing-state writer");
      }
    },
    close() {
      closed = true;
      clearNodeSqliteKyselyCacheForDatabase(db);
      closeTrackedStateDatabase(db);
    },
  };
}
