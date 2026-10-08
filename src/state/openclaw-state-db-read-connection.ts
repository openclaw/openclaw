import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  createSqliteLifecycleAggregateError,
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { getSqlitePinnedReadSnapshot } from "../infra/sqlite-pinned-read-snapshot.js";
import { retainSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import {
  admitSqliteSchema,
  isSqliteSchemaAdmissionCold,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { acquireSqliteSnapshotReadToken } from "../infra/sqlite-snapshot-staging.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../infra/sqlite-wal.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  getSqliteWorkerStateIntegrityAdmission,
  runWithSqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openTrackedStateDatabaseResult } from "./openclaw-state-db-handle.js";
import {
  invalidateOpenClawStateRuntimeIntegrity,
  type OpenClawStateIntegrityPolicy,
} from "./openclaw-state-db-integrity-admission.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  assertSupportedStateSchemaVersion,
  type StateSchemaContentVersionRowReader,
} from "./openclaw-state-db-schema-version.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export type OpenClawStateReadConnection = {
  database: Pick<OpenClawStateDatabase, "db" | "path">;
  snapshotSource?: {
    retain(): {
      location: string;
      cleanupRoot?: string;
      assertCurrent(): void;
      release(): void;
    };
  };
  close: (retain?: boolean) => boolean;
};

type RetainedReader = {
  connection: OpenClawStateReadConnection;
  identity: DatabasePathIdentity;
  retiring: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  directAdmission?: {
    existingSchema: boolean;
    integrity: OpenClawStateWorkerContext["stateIntegrity"];
  };
  unregisterDirectClose?: () => void;
};
const retainedReaders = new Map<string, RetainedReader>();
let unregisterExitClose: (() => void) | undefined;

function retireReader(reader: RetainedReader): void {
  if (retainedReaders.get(reader.identity.key) !== reader) {
    return;
  }
  clearTimeout(reader.idleTimer);
  reader.retiring = true;
  reader.connection.close();
  retainedReaders.delete(reader.identity.key);
  reader.unregisterDirectClose?.();
  if (!retainedReaders.size) {
    unregisterExitClose?.();
    unregisterExitClose = undefined;
  }
}

function ownDirectReaderLifecycle(reader: RetainedReader): void {
  if (reader.unregisterDirectClose) {
    return;
  }
  const { identity } = reader;
  const unregisterResource = registerOpenClawStateDatabaseAsyncResource({
    async close(closingIdentity) {
      if (
        !closingIdentity ||
        closingIdentity.key === identity.key ||
        closingIdentity.canonicalPath === identity.canonicalPath
      ) {
        retireReader(reader);
      }
    },
  });
  const unregisterLifecycle = registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (
      (event.kind === "closed" || event.kind === "terminal-failure") &&
      (event.path === reader.connection.database.path || event.identity?.key === identity.key)
    ) {
      retireReader(reader);
    }
  });
  reader.unregisterDirectClose = () => {
    unregisterResource();
    unregisterLifecycle();
  };
}

/** Prepare a live authority reader; each later use executes only its caller's synchronous query. */
export function prepareOpenClawStateDirectReader(context: OpenClawStateWorkerContext): {
  read<T>(operation: (database: OpenClawStateReadOnlyDatabase) => T): T;
} {
  const pathname = context.admission.databasePath;
  const identity = { ...context.admission.identity };
  const signal = getAsyncWorkSignal();
  const assertSource = () => {
    signal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    context.maintenanceScope?.assertReadAdmission();
    context.admission.assertCurrent();
    openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(pathname, "cached-read");
    assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
    const integrity = context.stateIntegrity;
    if (
      (integrity && Atomics.load(new BigInt64Array(integrity.revision), 0) !== integrity.epoch) ||
      (context.existingSchemaPath !== undefined &&
        (!integrity || Atomics.load(new BigInt64Array(integrity.proof), 0) === -1n))
    ) {
      throw new Error("Direct shared-state reader requires current integrity admission");
    }
  };
  const inContext = <T>(operation: () => T): T => {
    const run = () => runWithSqliteWorkerStateContext(context, operation);
    return context.runInCapturedSchemaScope ? context.runInCapturedSchemaScope(run) : run();
  };
  const reader = inContext(() => {
    assertSource();
    if (!identity.key.startsWith("file:")) {
      throw new Error("Direct shared-state reader requires an existing physical source");
    }
    const previous = retainedReaders.get(identity.key);
    const borrowed = borrowStateReadConnection(pathname, identity.key);
    if (borrowed.status === "unavailable") {
      throw borrowed.error;
    }
    const retained = retainedReaders.get(identity.key);
    if (!retained || retained.connection.database.db !== borrowed.value.database.db) {
      borrowed.value.close();
      throw new Error("Direct shared-state reader lost its retained connection");
    }
    if (
      retained.connection.database.db.isTransaction ||
      getSqlitePinnedReadSnapshot(retained.connection.database.db)
    ) {
      throw new Error("Direct shared-state reader cannot admit a transaction or snapshot");
    }
    try {
      const existingSchema = isExistingOpenClawStateSchema(
        pathname,
        retained.connection.database.db,
      );
      const admitted = retained.directAdmission;
      if (
        !admitted ||
        admitted.existingSchema !== existingSchema ||
        admitted.integrity?.revision !== context.stateIntegrity?.revision ||
        admitted.integrity?.epoch !== context.stateIntegrity?.epoch
      ) {
        runSqliteReadOperationSync(retained.connection.database.db, () => {
          admitStateReadSchemaFacts(retained.connection.database.db, pathname);
          assertStateReadSchemaForPolicy(
            retained.connection.database.db,
            pathname,
            existingSchema,
            existingSchema ? "require-proof" : undefined,
          );
        });
        retained.directAdmission = { existingSchema, integrity: context.stateIntegrity };
      }
      ownDirectReaderLifecycle(retained);
      if (retained !== previous) {
        context.maintenanceScope?.own(retained, "shared-resources", () => {
          const closingScope = getOpenClawDatabaseMaintenanceScope();
          if (closingScope && isOpenClawDatabaseMaintenanceResourceOwned(retained, closingScope)) {
            retireReader(retained);
          }
        });
      }
      assertSource();
      scheduleReaderRetirement(retained);
      return retained;
    } catch (error) {
      try {
        retireReader(retained);
      } catch (cleanupError) {
        throwSqliteLifecycleErrors(
          [error, cleanupError],
          "Direct shared-state reader admission and cleanup failed",
        );
      }
      throw error;
    }
  });
  const assertCurrent = () => {
    assertSource();
    const db = reader.connection.database.db;
    if (retainedReaders.get(identity.key) !== reader || reader.retiring || !db.isOpen) {
      throw new Error("Direct shared-state reader is closed");
    }
    if (db.isTransaction || getSqlitePinnedReadSnapshot(db)) {
      throw new Error("Direct shared-state reader cannot use a transaction or snapshot");
    }
    assertTransactionUsable(db);
  };
  return {
    read(operation) {
      return inContext(() => {
        assertCurrent();
        try {
          const value = operation(reader.connection.database);
          if (isPromiseLike(value)) {
            throw new SqliteCoordinatorError("Direct shared-state read must remain synchronous");
          }
          assertCurrent();
          scheduleReaderRetirement(reader);
          return value;
        } catch (error) {
          if (isSqliteCorruptionError(error)) {
            invalidateOpenClawStateRuntimeIntegrity(reader.connection.database.db);
            try {
              retireReader(reader);
            } catch (cleanupError) {
              throwSqliteLifecycleErrors(
                [error, cleanupError],
                "Direct shared-state read and cleanup failed",
              );
            }
          }
          throw error;
        }
      });
    },
  };
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
  observeOpenClawDatabaseMaintenanceResource(retained);
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

export function assertStateReadSchema(
  database: DatabaseSync,
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

function assertStateReadSchemaForPolicy(
  database: DatabaseSync,
  pathname: string,
  existingSchema: boolean,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
  readContentVersionRow?: StateSchemaContentVersionRowReader,
): void {
  if (existingSchema) {
    assertExistingOpenClawStateRuntimeSchema(
      database,
      pathname,
      getSqliteWorkerStateIntegrityAdmission(),
      integrityPolicy,
    );
  } else {
    assertSupportedStateSchemaVersion(database, pathname, undefined, readContentVersionRow);
  }
}

function admitStateReadSchemaFacts(database: DatabaseSync, pathname: string): void {
  try {
    admitSqliteSchema(database, (userVersion) =>
      assertSupportedStateSchemaVersion(database, pathname, {
        userVersion,
        contentVersion: userVersion,
      }),
    );
  } catch (error) {
    // An unreadable newer catalog must not be mistaken for a repair this build can perform.
    let version: number;
    try {
      version = readSqliteUserVersion(database);
    } catch {
      throw normalizeOpenClawStateSchemaReadError(error, pathname);
    }
    if (version > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        pathname,
        version,
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    }
    throw normalizeOpenClawStateSchemaReadError(error, pathname);
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
    closeAdmission = openStateSchemaReadAdmission?.(opened.database.db);
    // Scope and path policy are authority, not ordinary schema SQL failure.
    const existingSchema = isExistingOpenClawStateSchema(pathname, opened.database.db);
    try {
      result = {
        status: "available",
        value: runSqliteReadOperationSync(opened.database.db, () => {
          const coldAdmission = !existingSchema && isSqliteSchemaAdmissionCold(opened.database.db);
          admitStateReadSchemaFacts(opened.database.db, pathname);
          if (coldAdmission) {
            // A peer can upgrade after catalog capture releases its SQLite snapshot.
            return runSqliteReadOperationSync(
              opened.database.db,
              () => {
                assertStateReadSchemaForPolicy(
                  opened.database.db,
                  pathname,
                  existingSchema,
                  undefined,
                  readContentVersionRow,
                );
                return operation(opened.database);
              },
              "fresh",
            );
          }
          assertStateReadSchemaForPolicy(
            opened.database.db,
            pathname,
            existingSchema,
            undefined,
            readContentVersionRow,
          );
          return operation(opened.database);
        }),
      };
    } catch (error) {
      if (isSqliteCorruptionError(error)) {
        invalidateOpenClawStateRuntimeIntegrity(opened.database.db);
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
      admitStateReadSchemaFacts(connection.database.db, pathname);
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
  let closing = false;
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
    snapshotSource: snapshot
      ? {
          retain() {
            const assertCurrent = () => {
              if (closing || closed) {
                throw new Error("Shared-state snapshot source is closing or closed");
              }
            };
            assertCurrent();
            return {
              location: snapshot.location,
              cleanupRoot: snapshot.cleanupRoot,
              assertCurrent,
              release: retainSnapshotTempDirectory(
                snapshot.cleanupRoot ?? path.dirname(snapshot.location),
              ),
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
