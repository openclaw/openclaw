import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { resolveSqliteDatabaseFilePath } from "../infra/sqlite-database-admission.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  createSqliteLifecycleAggregateError,
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { retainSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { acquireSqliteSnapshotReadToken } from "../infra/sqlite-snapshot-staging.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import { registerSqliteCacheExitClose } from "../infra/sqlite-wal.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import {
  assertStateFileSnapshotAllowed,
  isStatePostgres,
  openExistingStatePostgresConnection,
} from "./openclaw-state-db-engine.js";
import { openTrackedStateDatabaseResult } from "./openclaw-state-db-handle.js";
import {
  invalidateOpenClawStateRuntimeIntegrity,
  type OpenClawStateIntegrityPolicy,
} from "./openclaw-state-db-integrity-admission.js";
import { assertStateReadSchemaForPolicy } from "./openclaw-state-db-read-schema.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  admitStateSchemaFacts,
  type StateSchemaContentVersionRowReader,
} from "./openclaw-state-db-schema-version.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

export type OpenClawStateReadConnection = {
  database: { db: EngineConnection; path: string };
  snapshotSource?: {
    retain(): {
      location: string;
      cleanupRoot?: string;
      release(): Promise<void>;
    };
  };
  close: (retain?: boolean) => boolean;
};

type RetainedReader = {
  connection: OpenClawStateReadConnection;
  identity: DatabasePathIdentity;
  retiring: boolean;
  borrowed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const retainedReaders = new Map<string, RetainedReader>();
const corruptedReaders = new WeakSet<EngineConnection>();
let unregisterExitClose: (() => void) | undefined;

function retireReader(reader: RetainedReader): void {
  if (retainedReaders.get(reader.identity.key) !== reader) {
    return;
  }
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
  // Unproven close delegates the same TTL to pool retirement after task custody is released.
  if (
    !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources ||
    retainedReaders.get(reader.identity.key) !== reader
  ) {
    return;
  }
  clearTimeout(reader.idleTimer);
  reader.idleTimer = runInDetachedAsyncContext(() =>
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
  if (isStatePostgres()) {
    return openStateReadConnectionResult(pathname, pathname, expectedIdentity, undefined, true);
  }
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
  if (reader?.borrowed) {
    // A nested reader must not close its caller's retained connection.
    return openStateReadConnectionResult(pathname, pathname, identity.key);
  }
  if (!reader) {
    const opening = openStateReadConnectionResult(pathname, pathname, identity.key);
    if (opening.status === "unavailable") {
      return opening;
    }
    reader = { connection: opening.value, identity, retiring: false, borrowed: false };
    retainedReaders.set(identity.key, reader);
    unregisterExitClose ??= registerSqliteCacheExitClose(closeRetainedOpenClawStateReadConnections);
  }
  const retained = reader;
  observeOpenClawDatabaseMaintenanceResource(retained);
  retained.borrowed = true;
  clearTimeout(retained.idleTimer);
  return {
    status: "available",
    value: {
      database: { db: retained.connection.database.db, path: pathname },
      close(keep) {
        retained.borrowed = false;
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

export function assertStateReadSchema(
  database: EngineConnection,
  pathname: string,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
): void {
  assertStateReadSchemaForPolicy(
    database,
    pathname,
    isExistingOpenClawStateSchema(pathname, database),
    integrityPolicy,
  );
}

export function withOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
  expectedIdentity?: string,
  snapshotRoot?: string,
  retainConnection = false,
  readContentVersionRow?: StateSchemaContentVersionRowReader,
): T {
  const result = readOpenClawStateReadOnlyLocation(
    operation,
    pathname,
    source,
    openStateSchemaReadAdmission,
    expectedIdentity,
    snapshotRoot,
    retainConnection,
    readContentVersionRow,
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
  readContentVersionRow?: StateSchemaContentVersionRowReader,
): OpenClawStateSettledRead<T> {
  const opening =
    retainConnection && source === pathname && !snapshotRoot
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
    if (openStateSchemaReadAdmission) {
      if (isPostgresSqlConnection(opened.database.db)) {
        requireNativeDatabaseFile("postgres", "repair");
      }
      closeAdmission = openStateSchemaReadAdmission(opened.database.db);
    }
    // Scope and path policy are authority, not ordinary schema SQL failure.
    const existingSchema = isExistingOpenClawStateSchema(pathname, opened.database.db);
    try {
      const read = () =>
        runSqliteReadOperationSync(opened.database.db, () => {
          admitStateSchemaFacts(opened.database.db, pathname);
          assertStateReadSchemaForPolicy(
            opened.database.db,
            pathname,
            existingSchema,
            undefined,
            readContentVersionRow,
          );
          return operation(opened.database);
        });
      result = {
        status: "available",
        value: isPostgresSqlConnection(opened.database.db)
          ? opened.database.db.runTransaction(read, undefined, true)
          : read(),
      };
    } catch (error) {
      if (!isPostgresSqlConnection(opened.database.db) && isSqliteCorruptionError(error)) {
        invalidateOpenClawStateRuntimeIntegrity(opened.database.db);
        corruptedReaders.add(opened.database.db);
      }
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
    // Conservative runtimes can retain native handles after logical close. The
    // snapshot owner warns and keeps its cleanup custody until process exit.
    const allowDeferredSnapshotCleanup =
      typeof source !== "string" &&
      errors.length === 0 &&
      result?.status === "available" &&
      !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources;
    if (
      !opened.close(
        errors.length === 0 &&
          result?.status === "available" &&
          !corruptedReaders.has(opened.database.db),
      ) &&
      !allowDeferredSnapshotCleanup
    ) {
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

export function openOpenClawStateReadOnlyLocation(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
) {
  const connection = openOpenClawStateReadConnection(pathname, source);
  try {
    runSqliteReadOperationSync(connection.database.db, () => {
      admitStateSchemaFacts(connection.database.db, pathname);
      assertStateReadSchema(connection.database.db, pathname);
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
  const physicalLocation = resolveSqliteDatabaseFilePath(location);
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
    if (isStatePostgres()) {
      if (source !== pathname || snapshotRoot) {
        assertStateFileSnapshotAllowed();
      }
      if (checkSchemaPolicy) {
        isExistingOpenClawStateSchema(pathname);
      }
      const postgres = openExistingStatePostgresConnection(pathname, expectedIdentity);
      if (postgres) {
        return { status: "available", value: postgres };
      }
    }
    if (expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(physicalLocation, expectedIdentity);
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
  let closing = false;
  let snapshotReaders = 0;
  const database = {
    db,
    path: pathname,
    afterClose: (): undefined => {
      releaseToken?.();
      if (snapshot && snapshotReaders === 0 && !snapshot.cleanup()) {
        throw new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete.");
      }
      return undefined;
    },
  };
  const connection: OpenClawStateReadConnection = {
    database: { db, path: pathname },
    snapshotSource: snapshot
      ? {
          retain() {
            if (closing || closed) {
              throw new Error("Shared-state snapshot source is closing or closed");
            }
            const release = retainSnapshotTempDirectory(
              snapshot.cleanupRoot ?? path.dirname(snapshot.location),
            );
            snapshotReaders++;
            let released = false;
            return {
              location: snapshot.location,
              cleanupRoot: snapshot.cleanupRoot,
              async release() {
                if (!released) {
                  released = true;
                  release();
                  snapshotReaders--;
                }
                // The synchronous reader closes first; its last async child removes the bytes.
                if (closed && snapshotReaders === 0 && !(await snapshot.cleanupAsync())) {
                  throw new SnapshotCleanupIncompleteError(
                    "Shared-state snapshot cleanup is incomplete.",
                  );
                }
              },
            };
          },
        }
      : undefined,
    close() {
      if (closed) {
        return false;
      }
      closing = true;
      // A failed close remains owned for retry, including private snapshot handles.
      const errors = openClawStateDatabaseCache.closeOpenClawStateDatabaseHandle(database);
      if (errors.length === 1 && errors[0] instanceof SnapshotCleanupIncompleteError) {
        return false;
      }
      throwSqliteLifecycleErrors(errors, "Shared-state reader cleanup failed.");
      closed = true;
      return true;
    },
  };
  try {
    enableNodeSqliteKyselyStatementCache(db);
    if (expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(physicalLocation, expectedIdentity);
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
