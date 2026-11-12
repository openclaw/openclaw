import { existsSync } from "node:fs";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { isSqliteLockError, sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import type { OpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

/** Hold native file-removal exclusion under the maintenance owner until it drains. */
export function retainSqliteDatabaseRemovalExclusion(
  databasePath: string,
  maintenance: OpenClawDatabaseMaintenanceScope,
): void {
  if (!existsSync(databasePath)) {
    return;
  }
  const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(databasePath));
  const close = () => {
    if (!database.isOpen) {
      return;
    }
    const errors: unknown[] = [];
    try {
      if (database.isTransaction) {
        database.exec("ROLLBACK"); // sqlite-allow-raw -- Release the native removal exclusion before close.
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      database.close();
    } catch (error) {
      errors.push(error);
    }
    throwSqliteLifecycleErrors(errors, "SQLite state removal exclusion cleanup failed.");
  };
  try {
    // The maintenance owner drains this handle after state removal. A failed
    // close retains both native custody and the external process owner.
    maintenance.own(database, "shared-handles", close);
    // Exclusive connection mode obtains the main-file lock even in WAL mode.
    // Do not change journal_mode: a refused removal must preserve recovery bytes.
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;"); // sqlite-allow-raw -- Native file-removal exclusion, without mutating journal mode.
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite state removal admission and cleanup both failed.",
        error,
      );
    }
    if (isSqliteLockError(error)) {
      throw new Error(
        "Cannot remove OpenClaw state directory while another SQLite connection is active",
        {
          cause: error,
        },
      );
    }
    const code = sqlitePrimaryResultCode(error);
    // Explicit reset may remove corrupt state after process ownership is established.
    if (code !== 11 && code !== 26) {
      throw error;
    }
    return;
  }
  if (process.platform === "win32") {
    // WinVFS denies FILE_SHARE_DELETE: any peer handle prevents unlink. Our
    // own probe must close so removal can proceed when no peer remains.
    close();
  }
}
