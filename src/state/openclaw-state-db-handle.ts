// The handle lease outlives transactions and maintenance, including close-time WAL work.
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import { acquireStateDatabaseHandleLease } from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const handleLeases = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseHandleLeases"),
  () => new WeakMap<DatabaseSync, { release: () => void }>(),
);

type StateDatabaseOpenOptions = {
  existingOnly?: boolean;
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

/** Only native open failure with a released lease is an ordinary read failure. */
export function openTrackedStateDatabaseResult(
  pathname: string,
  options?: StateDatabaseOpenOptions,
): { status: "available"; database: DatabaseSync } | { status: "unavailable"; error: unknown } {
  const lease = acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 });
  try {
    const location = options?.existingOnly ? resolveExistingSqliteFileUri(pathname) : pathname;
    const nativeOptions = options?.readOnly
      ? { readOnly: true, timeout: options.timeout }
      : { enableForeignKeyConstraints: options?.enableForeignKeyConstraints };
    const database = withSqliteNativeOpen(() => openNodeSqliteDatabase(location, nativeOptions));
    handleLeases.set(database, lease);
    return { status: "available", database };
  } catch (error) {
    lease.release();
    return { status: "unavailable", error };
  }
}

export function closeTrackedStateDatabase(database: DatabaseSync): void {
  try {
    if (database.isOpen) {
      database.close();
    }
  } finally {
    // A failed close that leaves SQLite live cannot surrender file protection.
    if (!database.isOpen) {
      handleLeases.get(database)?.release();
      handleLeases.delete(database);
    }
  }
}
