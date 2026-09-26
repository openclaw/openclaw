// Native open/close and physical identity admission share one owner.
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";

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
    const database = withSqliteNativeOpen(() => openNodeSqliteDatabase(location, nativeOptions));
    try {
      assertStateDatabaseAccessAllowed(pathname);
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
