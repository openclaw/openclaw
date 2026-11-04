// Native open/close and physical identity admission share one owner.
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteDisposeCallback,
} from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection, sqlPublicationAnchor } from "../infra/sql-connection.js";
import { prepareSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import { isSqliteWalWorkerMaintained } from "../infra/sqlite-wal-write-admission.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabase, StateDatabaseHandle } from "./openclaw-state-db-contract.js";

const identities = resolveGlobalSingleton(
  Symbol.for("openclaw.stateNativeIdentities"),
  () => new WeakMap<DatabaseSync, DatabasePathIdentity>(),
);

/** Physical identity admitted by the native opener, never a later pathname observation. */
export function readTrackedStateDatabaseIdentity(database: EngineConnection) {
  return identities.get(sqlPublicationAnchor(database));
}

type StateDatabaseOpenOptions = {
  existingOnly?: boolean;
  expectedIdentity?: string;
  readOnly?: boolean;
  timeout?: number;
  enableForeignKeyConstraints?: false;
};

export function openTrackedStateDatabase(
  pathname: string,
  options?: StateDatabaseOpenOptions,
): DatabaseSync {
  const result = openTrackedStateDatabaseResult(pathname, options);
  if (result.status === "unavailable") {
    throw result.error;
  }
  return result.database;
}

/** Native open failure is an ordinary read failure; admitted handles retain their own cleanup. */
export function openTrackedStateDatabaseResult(
  pathname: string,
  options?: StateDatabaseOpenOptions,
): { status: "available"; database: DatabaseSync } | { status: "unavailable"; error: unknown } {
  assertStateDatabaseAccessAllowed(pathname);
  try {
    if (options?.expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(pathname, options.expectedIdentity);
    }
    const location =
      options?.existingOnly || options?.expectedIdentity !== undefined
        ? resolveExistingSqliteFileUri(pathname)
        : pathname;
    const nativeOptions = options?.readOnly
      ? { readOnly: true, timeout: options.timeout }
      : { enableForeignKeyConstraints: options?.enableForeignKeyConstraints };
    const openingIdentity = readDatabasePathIdentitySync(pathname);
    const database = withSqliteNativeOpen(() => openNodeSqliteDatabase(location, nativeOptions));
    try {
      assertStateDatabaseAccessAllowed(pathname);
      if (openingIdentity.key.startsWith("file:")) {
        assertExistingDatabaseIdentity(pathname, openingIdentity.key, openingIdentity.birthtime);
      }
      const identity = openingIdentity.key.startsWith("file:")
        ? openingIdentity
        : readDatabasePathIdentitySync(pathname);
      if (identity.key.startsWith("file:")) {
        identities.set(database, identity);
        const unregister = registerNodeSqliteDisposeCallback(database, () => {
          identities.delete(database);
          unregister();
        });
      }
    } catch (error) {
      database.close();
      throw error;
    }
    return { status: "available", database };
  } catch (error) {
    return { status: "unavailable", error };
  }
}

export function closeTrackedStateDatabase(database: DatabaseSync): void {
  if (database.isOpen) {
    database.close();
  }
}

/** Finish all native close stages even when a previous stage failed. */
export function closeStateDatabaseHandle(
  database: StateDatabaseHandle,
  options?: Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0],
): { errors: unknown[]; cleanupPending: boolean } {
  const errors: unknown[] = [];
  if (isPostgresSqlConnection(database.db)) {
    for (const connection of [database.db, database.db.anchor]) {
      if (connection === database.db.anchor && database.db.isOpen) {
        break;
      }
      try {
        if (connection.isOpen) {
          connection.close();
        }
      } catch (error) {
        errors.push(error);
      }
    }
    let cleanupPending = database.db.isOpen || database.db.anchor.isOpen;
    if (!cleanupPending) {
      try {
        database.afterClose?.();
      } catch (error) {
        errors.push(error);
        cleanupPending = true;
      }
    }
    return { errors, cleanupPending };
  }
  using seal = prepareSqliteDatabaseCleanClose(database.db);
  const delegated = isSqliteWalWorkerMaintained(database.db);
  const priorCheckpointError = database.walMaintenance?.health?.state === "error";
  let checkpointed = false;
  try {
    checkpointed =
      database.walMaintenance?.close(options) === true && options?.checkpointMode !== "PASSIVE";
  } catch (error) {
    errors.push(error);
  }
  try {
    clearNodeSqliteKyselyCacheForDatabase(database.db);
  } catch (error) {
    errors.push(error);
  }
  try {
    closeTrackedStateDatabase(database.db);
  } catch (error) {
    errors.push(error);
  }
  let cleanupPending = false;
  if (!database.db.isOpen) {
    try {
      database.afterClose?.();
    } catch (error) {
      errors.push(error);
      cleanupPending = true;
    }
  }
  if (
    errors.length === 0 &&
    !cleanupPending &&
    options?.checkpointMode !== "PASSIVE" &&
    (checkpointed || (delegated && !priorCheckpointError))
  ) {
    // Native last-close can drain delegated WAL; the seal owner still requires empty journals.
    seal.publish();
  }
  return { errors, cleanupPending };
}
