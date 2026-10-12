// Native open/close and physical identity admission share one owner.
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteDisposeCallback,
} from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { prepareSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import { cancelSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
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
export function readTrackedStateDatabaseIdentity(database: DatabaseSync) {
  return identities.get(database);
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
  const publishSeal = prepareSqliteDatabaseCleanClose(database.db);
  let checkpointed = false;
  try {
    void cancelSqliteWalWriteAdmission(database.db);
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
  if (checkpointed && errors.length === 0 && !cleanupPending) {
    publishSeal();
  }
  return { errors, cleanupPending };
}
