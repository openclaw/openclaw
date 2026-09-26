import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  createSqliteLifecycleAggregateError,
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { acquireSqliteSnapshotReadToken } from "../infra/sqlite-snapshot-staging.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../infra/sqlite-wal.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
  type OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openTrackedStateDatabaseResult } from "./openclaw-state-db-handle.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

export type OpenClawStateReadConnection = {
  database: Pick<OpenClawStateDatabase, "db" | "path">;
  close: (retain?: boolean) => boolean;
};

type RetainedReader = {
  connection: OpenClawStateReadConnection;
  identity: DatabasePathIdentity;
  retiring: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const retainedReaders = new Map<string, RetainedReader>();
let unregisterExitClose: (() => void) | undefined;

function retireReader(reader: RetainedReader): void {
  clearTimeout(reader.idleTimer);
  reader.retiring = true;
  reader.connection.close();
  retainedReaders.delete(reader.identity.key);
  if (!retainedReaders.size) {
    unregisterExitClose?.();
    unregisterExitClose = undefined;
  }
}

function scheduleReaderRetirement(reader: RetainedReader): void {
  if (retainedReaders.get(reader.identity.key) !== reader) {
    return;
  }
  clearTimeout(reader.idleTimer);
  reader.idleTimer = runInSqliteMaintenanceContext(() =>
    setTimeout(() => {
      try {
        retireReader(reader);
      } catch (error) {
        process.emitWarning(`Idle shared-state reader cleanup failed: ${String(error)}`);
        scheduleReaderRetirement(reader);
      }
    }, SQLITE_IDLE_HANDLE_TTL_MS),
  );
  reader.idleTimer.unref?.();
}

/** The host joins this receipt before allowing replacement or deletion of live state. */
export function closeRetainedOpenClawStateReadConnections(identity?: string): void {
  const errors: unknown[] = [];
  for (const reader of retainedReaders.values()) {
    if (identity === undefined || reader.identity.key === identity) {
      try {
        retireReader(reader);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  throwSqliteLifecycleErrors(errors, "Retained shared-state reader cleanup failed.");
}

function borrowStateReadConnection(
  pathname: string,
  expectedIdentity?: string,
): OpenClawStateSettledRead<OpenClawStateReadConnection> {
  isExistingOpenClawStateSchema(pathname);
  const identity = readDatabasePathIdentitySync(pathname);
  if (expectedIdentity !== undefined) {
    assertExistingDatabaseIdentity(pathname, expectedIdentity);
  }
  for (const previous of retainedReaders.values()) {
    if (
      previous.identity.canonicalPath === identity.canonicalPath &&
      previous.identity.key !== identity.key
    ) {
      retireReader(previous);
    }
  }
  if (!identity.key.startsWith("file:")) {
    return openStateReadConnectionResult(pathname, pathname, expectedIdentity);
  }
  let reader = retainedReaders.get(identity.key);
  if (reader?.retiring || (reader && !reader.connection.database.db.isOpen)) {
    retireReader(reader);
    reader = undefined;
  }
  if (!reader) {
    const opening = openStateReadConnectionResult(pathname, pathname, identity.key);
    if (opening.status === "unavailable") {
      return opening;
    }
    reader = { connection: opening.value, identity, retiring: false };
    retainedReaders.set(identity.key, reader);
    unregisterExitClose ??= registerSqliteCacheExitClose(closeRetainedOpenClawStateReadConnections);
  }
  const retained = reader;
  clearTimeout(retained.idleTimer);
  return {
    status: "available",
    value: {
      database: { db: retained.connection.database.db, path: pathname },
      close(keep) {
        if (
          keep &&
          retained.connection.database.db.isOpen &&
          !retained.connection.database.db.isTransaction
        ) {
          scheduleReaderRetirement(retained);
        } else {
          retireReader(retained);
        }
        return true;
      },
    },
  };
}

class SnapshotCleanupIncompleteError extends Error {}

export type OpenClawStateSettledRead<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; error: unknown };

export function assertStateReadSchema(database: DatabaseSync, pathname: string): void {
  assertStateReadSchemaForPolicy(
    database,
    pathname,
    isExistingOpenClawStateSchema(pathname, database),
  );
}

function assertStateReadSchemaForPolicy(
  database: DatabaseSync,
  pathname: string,
  existingSchema: boolean,
): void {
  if (existingSchema) {
    assertExistingOpenClawStateRuntimeSchema(database, pathname);
  } else {
    assertSupportedStateSchemaVersion(database, pathname);
  }
}

export function withOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
  expectedIdentity?: string,
  snapshotRoot?: string,
  retainConnection = false,
): T {
  const result = readOpenClawStateReadOnlyLocation(
    operation,
    pathname,
    source,
    openStateSchemaReadAdmission,
    expectedIdentity,
    snapshotRoot,
    retainConnection,
  );
  if (result.status === "unavailable") {
    throw result.error;
  }
  return result.value;
}

/** Return a failed read only after its native reader and admission have settled. */
export function readOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
  expectedIdentity?: string,
  snapshotRoot?: string,
  retainConnection = false,
): OpenClawStateSettledRead<T> {
  const opening =
    retainConnection && source === pathname && !snapshotRoot && !process.versions.bun
      ? borrowStateReadConnection(pathname, expectedIdentity)
      : openStateReadConnectionResult(pathname, source, expectedIdentity, snapshotRoot, true);
  if (opening.status === "unavailable") {
    return opening;
  }
  const opened = opening.value;
  const errors: unknown[] = [];
  let closeAdmission: (() => void) | undefined;
  let result!: OpenClawStateSettledRead<T>;
  try {
    closeAdmission = openStateSchemaReadAdmission?.(opened.database.db);
    // Scope and path policy are authority, not ordinary schema SQL failure.
    const existingSchema = isExistingOpenClawStateSchema(pathname, opened.database.db);
    try {
      runSqliteReadOperationSync(opened.database.db, () => {
        assertStateReadSchemaForPolicy(opened.database.db, pathname, existingSchema);
        admitSqliteSchema(opened.database.db);
      });
      result = { status: "available", value: operation(opened.database) };
    } catch (error) {
      result = { status: "unavailable", error };
    }
    const location = typeof source === "string" ? source : source.location;
    if (result.status === "available" && location === pathname && isPromiseLike(result.value)) {
      throw new SqliteCoordinatorError("SQLite source read must remain synchronous");
    }
    // A failed transaction rollback can preserve its original query error.
    assertTransactionUsable(opened.database.db);
  } catch (error) {
    errors.push(error);
  }
  try {
    closeAdmission?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (!opened.close(errors.length === 0 && result?.status === "available")) {
      throw new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete.");
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    if (result?.status === "unavailable" && !errors.includes(result.error)) {
      errors.unshift(result.error);
    }
    throwSqliteLifecycleErrors(errors, "Shared-state read and reader cleanup failed.");
  }
  return result;
}

/** Keep streamed rows on one private reader while callers yield or close the shared writer. */
export async function* iterateOpenClawStateDatabaseReadOnly<Row, Result>(
  source: OpenClawStateDatabase,
  operation: (database: OpenClawStateReadOnlyDatabase) => Generator<Row, Result>,
  env: NodeJS.ProcessEnv = process.env,
): AsyncGenerator<Row, Result> {
  const pathname = source.db.location();
  if (!pathname) {
    throw new Error("Streaming shared-state reads require a filesystem-backed database.");
  }
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  const opened = openOpenClawStateReadOnlyLocation(pathname, pathname);
  try {
    // sqlite-allow-raw -- Keep composite streamed reads in one native read-only snapshot.
    opened.database.db.exec("BEGIN");
    return yield* operation(opened.database);
  } catch (error) {
    openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(source, error);
    throw error;
  } finally {
    try {
      // Bun can retain statements after close; end the snapshot before releasing handle custody.
      if (opened.database.db.isTransaction) {
        opened.database.db.exec("ROLLBACK"); // sqlite-allow-raw -- End this owner's read-only snapshot.
      }
    } finally {
      opened.close();
    }
  }
}

export function openOpenClawStateReadOnlyLocation(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
) {
  const connection = openOpenClawStateReadConnection(pathname, source);
  try {
    runSqliteReadOperationSync(connection.database.db, () => {
      assertStateReadSchema(connection.database.db, pathname);
      admitSqliteSchema(connection.database.db);
    });
  } catch (error) {
    try {
      connection.close();
    } catch (cleanupError) {
      throwSqliteLifecycleErrors(
        [error, cleanupError],
        "Shared-state reader admission and cleanup failed.",
      );
    }
    throw error;
  }
  return connection;
}

/** Own one native reader; callers retain their runtime or maintenance schema policy. */
export function openOpenClawStateReadConnection(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  expectedIdentity?: string,
  snapshotRoot?: string,
): OpenClawStateReadConnection {
  const result = openStateReadConnectionResult(pathname, source, expectedIdentity, snapshotRoot);
  if (result.status === "unavailable") {
    throw result.error;
  }
  return result.value;
}

function openStateReadConnectionResult(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  expectedIdentity?: string,
  snapshotRoot?: string,
  checkSchemaPolicy = false,
): OpenClawStateSettledRead<OpenClawStateReadConnection> {
  const snapshot = typeof source === "string" ? undefined : source;
  const location = typeof source === "string" ? source : source.location;
  // The first catalog read needs the busy handler; installing a later PRAGMA is too late.
  const options = { readOnly: true, timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS };
  let releaseToken: (() => void) | undefined;
  const cleanupFailedOpen = (error: unknown) => {
    const errors = [error];
    try {
      releaseToken?.();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      if (snapshot && !snapshot.cleanup()) {
        errors.push(
          new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete."),
        );
      }
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1) {
      throw createSqliteLifecycleAggregateError(
        errors,
        "Shared-state reader open and cleanup failed.",
        error,
      );
    }
  };
  let native: ReturnType<typeof openTrackedStateDatabaseResult>;
  try {
    if (expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(location, expectedIdentity);
    }
    releaseToken = snapshotRoot ? acquireSqliteSnapshotReadToken(snapshotRoot) : undefined;
    if (checkSchemaPolicy) {
      isExistingOpenClawStateSchema(pathname);
    }
    if (location === pathname) {
      native = openTrackedStateDatabaseResult(pathname, options);
    } else {
      try {
        native = { status: "available", database: openNodeSqliteDatabase(location, options) };
      } catch (error) {
        native = { status: "unavailable", error };
      }
    }
  } catch (error) {
    cleanupFailedOpen(error);
    throw error;
  }
  if (native.status === "unavailable") {
    cleanupFailedOpen(native.error);
    return native;
  }
  const db = native.database;
  let closed = false;
  const database = {
    db,
    path: pathname,
    afterClose: (): undefined => {
      releaseToken?.();
      if (snapshot && !snapshot.cleanup()) {
        throw new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete.");
      }
      return undefined;
    },
  };
  const connection: OpenClawStateReadConnection = {
    database: { db, path: pathname },
    close() {
      if (closed) {
        return false;
      }
      // A failed close remains owned for retry, including private snapshot handles.
      const errors = openClawStateDatabaseCache.closeOpenClawStateDatabaseHandle(database);
      if (errors.length === 1 && errors[0] instanceof SnapshotCleanupIncompleteError) {
        return false;
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Shared-state reader cleanup failed.",
          errors[0],
        );
      }
      closed = true;
      return true;
    },
  };
  try {
    if (expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(location, expectedIdentity);
    }
  } catch (error) {
    try {
      if (!connection.close()) {
        throw new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete.");
      }
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Shared-state reader identity and cleanup failed.",
        error,
      );
    }
    throw error;
  }
  return { status: "available", value: connection };
}
