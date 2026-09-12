// Source readers participate in file exclusion without changing source SQLite state.
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { acquireStateDatabaseHandleLease } from "./state-database-coordinator.js";

// A failed native close cannot let GC retire its admission before child exit.
const unclosedSourceReads = new Set<{
  database: DatabaseSync;
  lease: { release: () => void };
}>();

export function withSqliteSourceHandle<T>(pathname: string, operation: () => T): T {
  return runWithSqliteCoordinator(
    acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 }),
    "SQLite source read",
    operation,
  );
}

/** Execute only in a child or a drained source scope: native close can release
 * another connection's process-wide POSIX locks. Failed close retains admission. */
export function withSqliteSourceReadDatabase<T>(
  pathname: string,
  operation: (database: DatabaseSync) => T,
): T {
  const lease = acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 });
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    return operation(database);
  } finally {
    try {
      database?.close();
    } finally {
      // If SQLite still owns a native handle, only process exit can release it.
      if (!database?.isOpen) {
        lease.release();
      } else {
        unclosedSourceReads.add({ database, lease });
      }
    }
  }
}

/** The executing source-copy child holds its own lease, including after parent loss. */
export async function withSqliteSourceHandleAsync<T>(
  pathname: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 });
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      lease.release();
    } catch (releaseError) {
      throw createSqliteLifecycleAggregateError(
        [error, releaseError],
        "SQLite source read and handle release both failed",
        error,
      );
    }
    throw error;
  }
  lease.release();
  return result;
}
