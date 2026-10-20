import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  assertSqliteIntegrity,
  SqliteRepairableForeignKeyError,
} from "../infra/sqlite-integrity.js";
import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import {
  assertSqliteSchemaContains,
  getCanonicalSqliteNamedIndexNames,
  getCanonicalSqliteTableNames,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
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
import {
  ensureStatePostgresFragment,
  isStatePostgres,
  openExistingStatePostgresConnection,
} from "./openclaw-state-db-engine.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { assertStateDatabaseIntegrityOnce } from "./openclaw-state-db-integrity-admission.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  assertOpenClawStateSchemaRepairAllowed,
  isExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "./openclaw-state-db-schema-version.js";
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
  integrityCheck?: "quick" | "full";
};
type OneShotWriteContract = ExistingWriteContract & {
  initializeAdditiveSchema?: boolean;
  recoverTaskDeliveryOrphans?: true;
};
type ExistingWriteOperation<T> = (database: {
  db: EngineConnection;
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
  schemaSql: string | undefined,
  compatibility?: SqliteSchemaCompatibility,
  integrityCheck: "quick" | "full" = "full",
): number {
  const version = assertSupportedStateSchemaVersion(db, pathname);
  assertExistingOpenClawStateSchemaMetadata(db, pathname, version);
  if (integrityCheck === "quick") {
    assertSqliteIntegrity(db, pathname, {
      check: "quick",
      tables: schemaSql === undefined ? undefined : getCanonicalSqliteTableNames(schemaSql),
    });
  } else {
    assertStateDatabaseIntegrityOnce(db, pathname);
  }
  if (schemaSql !== undefined) {
    assertSqliteSchemaContains(db, pathname, schemaSql, compatibility);
  }
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
  if (isStatePostgres()) {
    return createExistingPostgresStateWriter(pathname, contract, assertSameFile);
  }
  const db = openTrackedStateDatabase(pathname, {
    existingOnly: true,
    // Match Doctor: inbound dependents must fail validation, never cascade away.
    ...(contract.recoverTaskDeliveryOrphans ? { enableForeignKeyConstraints: false } : {}),
  });
  const admission = createStateSchemaAdmission(
    `state.subset:${createHash("sha256")
      .update(
        JSON.stringify([contract.schemaSql, contract.schemaCompatibility, contract.integrityCheck]),
      )
      .digest("hex")}`,
    (value) => (typeof value === "number" ? value : undefined),
    contract.integrityCheck === undefined ? "process" : undefined,
  );
  const ensureAdditiveSchema = contract.initializeAdditiveSchema
    ? createSqliteSchemaEnsurer(() => contract.schemaSql, {
        tables: getCanonicalSqliteTableNames(contract.schemaSql),
        indexes: getCanonicalSqliteNamedIndexNames(contract.schemaSql),
      })
    : undefined;
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
      admitStateSchemaFacts(db, pathname);
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
              needsAdmission && contract.initializeAdditiveSchema ? undefined : contract.schemaSql,
              contract.schemaCompatibility,
              contract.integrityCheck,
            );
          let version: number;
          let recoveryChanges: string[] = [];
          if (contract.recoverTaskDeliveryOrphans) {
            // Requested recovery is work, not a cached schema-admission fact.
            try {
              validate();
            } catch (error) {
              if (!(error instanceof SqliteRepairableForeignKeyError)) {
                throw error;
              }
            }
            recoveryChanges = recoverOrphanTaskDeliveryRows(db, pathname);
            version = validate();
          } else {
            version = priorVersion ?? validate();
          }
          if (needsAdmission && contract.initializeAdditiveSchema) {
            // Validate present objects before first use: CREATE IF NOT EXISTS
            // must not hide drift or repair an incomplete existing table.
            assertSqliteSchemaContains(db, pathname, contract.schemaSql, {
              ...contract.schemaCompatibility,
              allowedMissingTables: getCanonicalSqliteTableNames(contract.schemaSql),
            });
            admitSqliteSchema(db);
            ensureAdditiveSchema?.(db);
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

/** Reuse the admitted physical schema without running the candidate's version migrations. */
function createExistingPostgresStateWriter(
  pathname: string,
  contract: OneShotWriteContract,
  assertSameFile: () => void,
) {
  const connection = withEngineStoreAdmission(() => openExistingStatePostgresConnection(pathname));
  if (!connection) {
    throw new Error("Existing PostgreSQL state writer requires its selected engine");
  }
  const { db } = connection.database;
  const tables = getCanonicalSqliteTableNames(contract.schemaSql);
  return {
    run<T>(operation: ExistingWriteOperation<T>, options: ExistingWriteOptions) {
      if (!db.isOpen) {
        throw new Error("Existing-state writer is closed.");
      }
      if (options.database || options.readOnly) {
        throw new Error("Existing-state writes require their own tracked writable connection.");
      }
      const env = options.env ?? process.env;
      if (resolveDatabasePath({ path: options.path, env }) !== pathname) {
        throw new Error("Existing-state writer cannot change its database path.");
      }
      return withEngineStoreAdmission(() =>
        runManagedStateTransaction(
          db,
          () => {
            assertSameFile();
            assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
            const catalog = getPostgresPhysicalFacts(db)!.catalog;
            for (const table of tables) {
              if (contract.initializeAdditiveSchema) {
                ensureStatePostgresFragment(db, table);
              } else if (!catalog.some((fact) => fact.kind === "table" && fact.table === table)) {
                throw new Error(`Existing PostgreSQL state schema is missing ${table}`);
              }
            }
            const value = operation({ db, path: pathname, recoveryChanges: [] });
            assertSameFile();
            return value;
          },
          {
            databaseLabel: pathname,
            operationLabel: contract.operationLabel,
            beginLockFailureReporting: contract.beginLockFailureReporting,
          },
        ),
      );
    },
    assertSettled() {
      assertSameFile();
      assertTransactionUsable(db);
      if (db.isOpen && db.isTransaction) {
        throw new Error("Existing-state writer retained an unsettled transaction");
      }
    },
    close() {
      connection.close();
    },
  };
}
