import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { openDanglingWorkshopIndexReadAdmission } from "./openclaw-state-db-dangling-workshop-index.js";
import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const artifactPreservingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.artifactPreservingStateReads"),
  () => new AsyncLocalStorage<boolean>(),
);

const disposableStateReads = resolveGlobalSingleton(
  Symbol.for("openclaw.disposableStateReads"),
  () => new AsyncLocalStorage<{ path: string; active: boolean }[]>(),
);

const stateSnapshotReads = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSnapshotReads"),
  () =>
    new AsyncLocalStorage<{
      path: string;
      location: string;
      env: NodeJS.ProcessEnv;
      active: boolean;
    }>(),
);

/** Resolve a composite read from one online snapshot without redirecting live writers. */
export async function withOpenClawStateDatabaseReadSnapshot<T>(
  operation: () => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  const pathname = resolveReadOnlyPath(options);
  const current = stateSnapshotReads.getStore();
  if ((current?.active && current.path === pathname) || !existingPathOrUndefined(pathname)) {
    return await operation();
  }
  const env = options.env ?? process.env;
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  let prepared: PreparedSqliteReadOnlyLocation;
  try {
    prepared = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: isArtifactPreservingStateRead(),
    });
  } catch (error) {
    throw new Error(
      `Cannot read shared state for discovery: ${pathname}. Retry after the current state operation completes. ${String(error)}`,
      { cause: error },
    );
  }
  const scope = { path: pathname, location: prepared.location, env, active: true };
  await using _ = {
    async [Symbol.asyncDispose]() {
      scope.active = false;
      if (!(await prepared.cleanupAsync())) {
        throw new Error(`Shared-state discovery snapshot cleanup failed: ${pathname}`);
      }
    },
  };
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  return await stateSnapshotReads.run(scope, operation);
}

/** The caller owns this private database and removes its files after the scope closes. */
export async function withDisposableOpenClawStateReads<T>(
  pathname: string,
  operation: () => Promise<T>,
): Promise<T> {
  const scope = { path: path.resolve(pathname), active: true };
  try {
    return await disposableStateReads.run(
      [...(disposableStateReads.getStore() ?? []), scope],
      operation,
    );
  } finally {
    // Async descendants can retain the context after its owner starts cleanup.
    scope.active = false;
  }
}

function requiresArtifactPreservingSnapshot(pathname: string): boolean {
  return (
    isArtifactPreservingStateRead() &&
    !disposableStateReads.getStore()?.some((scope) => scope.active && scope.path === pathname)
  );
}

/** Admission scopes every nested reader without changing normal live-read semantics. */
export function withArtifactPreservingStateReads<T>(operation: () => T): T {
  return artifactPreservingReads.run(true, operation);
}

export function isArtifactPreservingStateRead(): boolean {
  return artifactPreservingReads.getStore() === true;
}

type OpenClawStateReadOnlyDatabase = {
  db: DatabaseSync;
  path: string;
};

type ScopedRead = ReturnType<typeof openOpenClawStateReadOnlyLocation>;
const synchronousReadSnapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.synchronousStateReadSnapshots"),
  (): { current: Map<string, ScopedRead> | undefined } => ({ current: undefined }),
);

/** One synchronous metadata operation shares private bytes, never later admission reads. */
export function withSynchronousArtifactPreservingStateSnapshot<T>(operation: () => T): T {
  if (!isArtifactPreservingStateRead() || synchronousReadSnapshots.current) {
    return operation();
  }
  const readers = new Map<string, ScopedRead>();
  synchronousReadSnapshots.current = readers;
  let result!: T;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    result = operation();
    if (isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite metadata snapshot scope must remain synchronous");
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    synchronousReadSnapshots.current = undefined;
    for (const reader of readers.values()) {
      try {
        if (!reader.close()) {
          cleanupErrors.push(new Error("Shared-state metadata snapshot cleanup is incomplete."));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    readers.clear();
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Shared-state metadata snapshot cleanup failed.",
    );
  }
  if (failed) {
    throw failure;
  }
  return result;
}

type ReusedOpenClawStateReadOnlyDatabase<T> = { reused: false } | { reused: true; value: T };

/** Missing runtime tables are empty only before state grows beyond checkpoint bootstrap. */
export function hasOpenClawStateTablesBeyondStartupCheckpoint(db: DatabaseSync): boolean {
  return (
    /* sqlite-allow-raw -- Read-only startup-checkpoint schema discriminator. */ db
      .prepare(
        "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name NOT IN ('schema_meta', 'state_leases') LIMIT 1",
      )
      .get() !== undefined
  );
}

function resolveReadOnlyPath(options: OpenClawStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function existingPathOrUndefined(pathname: string): string | undefined {
  try {
    statSync(pathname);
    return pathname;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function withOpenClawStateDatabaseReadOnlyIfOpen<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  const snapshot = stateSnapshotReads.getStore();
  if (snapshot?.active && snapshot.path === pathname) {
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
      pathname,
      snapshot.env,
    );
    return {
      reused: true,
      value: withOpenClawStateReadOnlyLocation(operation, pathname, snapshot.location),
    };
  }
  const opened = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(pathname);
  if (!opened?.db.isOpen || opened.db.isTransaction) {
    return { reused: false };
  }
  try {
    const closeSchemaReadAdmission = openDanglingWorkshopIndexReadAdmission(opened.db);
    try {
      // Process-local terminal failures evict this handle. Persisted quarantine
      // is checked on the next physical open so hot reads do not poll metadata.
      // A newer build can migrate this file while the handle stays open, so the
      // forward-compatibility gate still runs before any reused read.
      assertSupportedStateSchemaVersion(opened.db, pathname);
      observeOpenClawDatabaseMaintenanceResource(opened.db);
      return { reused: true, value: operation(opened) };
    } finally {
      closeSchemaReadAdmission?.();
    }
  } catch (error) {
    openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(opened, error);
    throw error;
  }
}

function withFreshOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  pathname: string,
): T {
  const env = options.env ?? process.env;
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  // Even read-only SQLite opens can create a missing WAL. The existing worker
  // snapshots committed WAL pages without touching source sidecars or caller-held locks.
  // One consistent snapshot per synchronous scope avoids mixed reads and duplicate copies.
  // Concurrent commits become visible in the next scope; this reader closes at scope end.
  const readers = synchronousReadSnapshots.current;
  if (readers && requiresArtifactPreservingSnapshot(pathname)) {
    let opened = readers.get(pathname);
    if (!opened) {
      opened = openOpenClawStateReadOnlyLocation(
        pathname,
        prepareSqliteReadOnlyLocationSync(pathname),
      );
      readers.set(pathname, opened);
    }
    assertSupportedStateSchemaVersion(opened.database.db, pathname);
    const result = operation(opened.database);
    if (isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite metadata snapshot read must remain synchronous");
    }
    return result;
  }
  const prepared = requiresArtifactPreservingSnapshot(pathname)
    ? prepareSqliteReadOnlyLocationSync(pathname)
    : undefined;
  return withOpenClawStateReadOnlyLocation(operation, pathname, prepared ?? pathname);
}

function openOpenClawStateReadOnlyLocation(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
) {
  const connection = openOpenClawStateReadConnection(pathname, source);
  const { db } = connection.database;
  let closeSchemaReadAdmission: (() => void) | undefined;
  const close = () => {
    const errors: unknown[] = [];
    let closed = false;
    try {
      closeSchemaReadAdmission?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      closed = connection.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Shared-state reader cleanup failed.");
    }
    return closed;
  };
  try {
    closeSchemaReadAdmission = openDanglingWorkshopIndexReadAdmission(db);
    assertSupportedStateSchemaVersion(db, pathname);
  } catch (error) {
    close();
    throw error;
  }
  return { database: connection.database, close };
}

function withOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
): T {
  const opened = openOpenClawStateReadOnlyLocation(pathname, source);
  try {
    const result = operation(opened.database);
    const location = typeof source === "string" ? source : source.location;
    if (location === pathname && isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite source read must remain synchronous");
    }
    return result;
  } finally {
    opened.close();
  }
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

/** Read shared state without joining writers; admission inherits artifact preservation. */
export function withOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const pathname = resolveReadOnlyPath(options);
  // Reusing a handle this process already holds keeps row loops cheap: opening
  // and closing a connection per call made shared-state reads scale with row
  // count. An in-flight transaction is skipped so callers never observe
  // uncommitted rows a fresh read-only connection could not have seen.
  if (synchronousReadSnapshots.current?.has(pathname)) {
    return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
  }
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
}

/** Read existing shared state while preserving non-missing filesystem failures. */
export function withExistingOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  if (synchronousReadSnapshots.current?.has(pathname)) {
    return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
  }
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  const existingPath = existingPathOrUndefined(pathname);
  return existingPath === undefined
    ? undefined
    : withFreshOpenClawStateDatabaseReadOnly(operation, options, existingPath);
}

/** Read existing shared state without creating or updating its SQLite sidecars. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  return withArtifactPreservingStateReads(() =>
    withExistingOpenClawStateDatabaseReadOnly(operation, options),
  );
}

/** Publication guards need current rows, never an inherited discovery snapshot. */
export function withExistingOpenClawStateDatabaseCurrentReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  return stateSnapshotReads.exit(() => {
    const pathname = resolveReadOnlyPath(options);
    const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
    if (reused.reused) {
      return reused.value;
    }
    if (existingPathOrUndefined(pathname) === undefined) {
      return undefined;
    }
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
      pathname,
      options.env ?? process.env,
    );
    return withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      prepareSqliteReadOnlyLocationSync(pathname),
    );
  });
}

/** Preserve source artifacts while allowing the caller to progress during snapshot preparation. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T | undefined> {
  return withArtifactPreservingStateReads(async () => {
    const pathname = resolveReadOnlyPath(options);
    const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
    if (reused.reused) {
      return reused.value;
    }
    if (existingPathOrUndefined(pathname) === undefined) {
      return undefined;
    }
    const env = options.env ?? process.env;
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    if (!requiresArtifactPreservingSnapshot(pathname)) {
      return withOpenClawStateReadOnlyLocation(operation, pathname, pathname);
    }
    const prepared = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: true,
    });
    try {
      // Verification can quarantine the live path while the snapshot child is running.
      openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    } catch (error) {
      prepared.cleanup();
      throw error;
    }
    return withOpenClawStateReadOnlyLocation(operation, pathname, prepared);
  });
}
