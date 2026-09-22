// Source readers participate in file exclusion without changing source SQLite state.
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { withSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import {
  acquireStateDatabaseHandleExclusion,
  acquireStateDatabaseHandleLease,
} from "./state-database-coordinator.js";

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
  inspectionOperation: "source" | "snapshot",
  operation: (database: DatabaseSync) => T,
): T;
export function withSqliteSourceReadDatabase<T>(
  pathname: string,
  inspectionOperation: "source" | "snapshot",
  operation: (database: DatabaseSync) => T,
  mode: "immutable",
): T | undefined;
export function withSqliteSourceReadDatabase<T>(
  pathname: string,
  inspectionOperation: "source" | "snapshot",
  operation: (database: DatabaseSync) => T,
  mode?: "immutable",
): T | undefined {
  const immutable = mode === "immutable";
  const acquire = immutable ? acquireStateDatabaseHandleExclusion : acquireStateDatabaseHandleLease;
  const lease = acquire({ databasePath: pathname, busyTimeoutMs: 0 });
  let database: DatabaseSync | undefined;
  try {
    const before = immutable ? statSync(pathname, { bigint: true }) : undefined;
    const hasSidecars = () =>
      ["-wal", "-shm", "-journal"].some(
        (suffix) => statSync(pathname + suffix, { throwIfNoEntry: false }) !== undefined,
      );
    const unchanged = () => {
      const current = statSync(pathname, { bigint: true });
      return (
        before?.isFile() &&
        current.dev === before.dev &&
        current.ino === before.ino &&
        current.ctimeNs === before.ctimeNs &&
        current.mtimeNs === before.mtimeNs &&
        current.size === before.size &&
        !hasSidecars()
      );
    };
    // Immutable reads ignore SQLite journals and locks. Exclude every managed
    // native owner and require a consolidated, unchanged source for this scope.
    if (immutable && hasSidecars()) {
      return undefined;
    }
    database = withSqliteInspectionOperation(inspectionOperation, () =>
      openNodeSqliteDatabase(immutable ? resolveImmutableSqliteFileUri(pathname) : pathname, {
        readOnly: true,
      }),
    );
    if (immutable && !unchanged()) {
      return undefined;
    }
    const result = operation(database);
    return immutable && !unchanged() ? undefined : result;
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

/** Revalidate every caller before it can join process-global snapshot work. */
export function assertSqliteSourceReadAllowed(pathname: string): void {
  const lease = acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 });
  lease.release();
}
