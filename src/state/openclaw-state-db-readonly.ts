import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { SqliteCoordinatorError, throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "../infra/sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import {
  acquireStateDatabaseHandleLease,
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseCanonicalMutation,
} from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { openDanglingWorkshopIndexReadAdmission } from "./openclaw-state-db-dangling-workshop-index.js";
import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createRetainedReadScope, runRetainedReadScope } from "./openclaw-state-read-scope.js";
import { createOpenClawStateReadTransport } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
  OpenClawStateReadOnlyDatabase,
  ReadResource,
  RetainedReadScope,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const artifactPreservingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.artifactPreservingStateReads"),
  () => new AsyncLocalStorage<boolean>(),
);

const disposableStateReads = resolveGlobalSingleton(
  Symbol.for("openclaw.disposableStateReads"),
  () => new AsyncLocalStorage<RetainedReadScope[]>(),
);

const stateSnapshotReads = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSnapshotReads"),
  () => new AsyncLocalStorage<RetainedReadScope & { location: string; env: NodeJS.ProcessEnv }>(),
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
  let admission: ReturnType<typeof captureOpenClawStateDatabaseReadAdmission>;
  let prepared: PreparedSqliteReadOnlyLocation;
  try {
    admission = captureOpenClawStateDatabaseReadAdmission(pathname);
    prepared = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: isArtifactPreservingStateRead(),
    });
  } catch (error) {
    throw new Error(
      `Cannot read shared state for discovery: ${pathname}. Retry after the current state operation completes. ${String(error)}`,
      { cause: error },
    );
  }
  const scope = Object.assign(
    createRetainedReadScope(pathname, admission.identity, async () => {
      if (!(await prepared.cleanupAsync())) {
        throw new Error(
          `Shared-state discovery snapshot cleanup failed: ${prepared.cleanupRoot ?? pathname}`,
        );
      }
    }),
    { location: prepared.location, env },
  );
  return await runRetainedReadScope(scope, async () => {
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    admission.assertCurrent();
    return await stateSnapshotReads.run(scope, operation);
  });
}

/** The caller owns this private database and removes its files after the scope closes. */
export async function withDisposableOpenClawStateReads<T>(
  pathname: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedPath = path.resolve(pathname);
  const scope = createRetainedReadScope(
    resolvedPath,
    captureOpenClawStateDatabaseReadAdmission(resolvedPath).identity,
  );
  return await runRetainedReadScope(scope, () =>
    disposableStateReads.run([...(disposableStateReads.getStore() ?? []), scope], operation),
  );
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
    try {
      close();
    } catch (cleanupError) {
      throwSqliteLifecycleErrors(
        [error, cleanupError],
        "Shared-state reader admission and cleanup failed.",
      );
    }
    throw error;
  }
  return { database: connection.database, close };
}

export function withOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
): T {
  const opened = openOpenClawStateReadOnlyLocation(pathname, source);
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = operation(opened.database);
    const location = typeof source === "string" ? source : source.location;
    if (location === pathname && isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite source read must remain synchronous");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    opened.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Shared-state read and reader cleanup failed.");
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

/** Execute a fixed read command while retaining source selection and cleanup. */
export function executeExistingOpenClawStateRead(
  options: OpenClawStateDatabaseOptions,
  command: OpenClawStateReadCommand,
): Promise<OpenClawStateReadReply | undefined> {
  const pathname = resolveReadOnlyPath(options);
  const current = stateSnapshotReads.getStore();
  const snapshot = current?.active && current.path === pathname ? current : undefined;
  const scopes: RetainedReadScope[] = [
    ...(snapshot ? [snapshot] : []),
    ...(disposableStateReads.getStore() ?? []).filter(
      (scope) => scope.active && scope.path === pathname,
    ),
  ];
  const context = captureOpenClawStateWorkerContext({
    path: pathname,
    env: snapshot?.env ?? options.env,
  });
  const mutation = prepareStateDatabaseCanonicalMutation(pathname);
  const excluded = hasStateDatabaseSourceExclusion(pathname);
  const preserveArtifacts = requiresArtifactPreservingSnapshot(pathname);
  for (const scope of scopes) {
    if (scope.work.isClosing) {
      return Promise.reject(new Error("Shared-state read scope is closing"));
    }
  }
  const run = async (): Promise<OpenClawStateReadReply | undefined> => {
    const controller = new AbortController();
    const producerSettled = createDeferredCore();
    const transport = createOpenClawStateReadTransport(command, (error) => controller.abort(error));
    let cleanupPending: Promise<void> | undefined;
    let transportStopped = false;
    let cleaned = false;
    let validated = false;
    const acceptanceErrors: unknown[] = [];
    let borrowed: ReturnType<typeof borrowOpenClawStateDatabaseForAsyncRead>;
    let sourcePin: ReturnType<typeof acquireStateDatabaseHandleLease> | undefined;
    let prepared: PreparedSqliteReadOnlyLocation | undefined;
    const authority: OpenClawStateReadAuthority = {
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
        context.maintenanceScope?.assertAdmission();
        context.admission.assertCurrent();
        mutation?.();
        if (excluded && !hasStateDatabaseSourceExclusion(pathname)) {
          throw new Error("Shared-state source read scope is closed");
        }
        borrowed?.assertCurrent();
        if (scopes.some((scope) => !scope.active)) {
          throw new Error("Shared-state read scope is closed");
        }
        openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
      },
    };
    const cleanup = (): Promise<void> => {
      if (cleaned) {
        return Promise.resolve();
      }
      return (cleanupPending ??= (async () => {
        // A failed stop can keep the producer pending. Retry that same transport first.
        if (!transportStopped) {
          await transport.close();
          transportStopped = true;
        }
        await producerSettled.promise;
        if (prepared) {
          if (!(await prepared.cleanupAsync())) {
            throw new Error(
              `Shared-state read snapshot cleanup failed: ${prepared.cleanupRoot ?? pathname}`,
            );
          }
          prepared = undefined;
        }
        if (!validated) {
          validated = true;
          try {
            authority.assertCurrent();
          } catch (error) {
            acceptanceErrors.push(error);
          }
        }
        const errors: unknown[] = [];
        try {
          sourcePin?.release();
          sourcePin = undefined;
        } catch (error) {
          errors.push(error);
        }
        try {
          borrowed?.release();
          borrowed = undefined;
        } catch (error) {
          errors.push(error);
        }
        throwSqliteLifecycleErrors(errors, "Shared-state read source release failed");
        cleaned = true;
        unregister();
        for (const scope of scopes) {
          scope.resources.delete(resource);
        }
      })().finally(() => {
        cleanupPending = undefined;
      }));
    };
    const resource: ReadResource = {
      async close() {
        controller.abort(new Error("Shared-state read admission closed"));
        await cleanup();
      },
    };
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      async close(identity) {
        if (
          !identity ||
          identity.key === context.admission.identity.key ||
          identity.canonicalPath === context.admission.identity.canonicalPath
        ) {
          await resource.close();
        }
      },
    });
    context.maintenanceScope?.own(resource, "shared-resources", () => resource.close());
    for (const scope of scopes) {
      scope.resources.add(resource);
    }
    const read = async () => {
      authority.assertCurrent();
      if (!snapshot) {
        borrowed = borrowOpenClawStateDatabaseForAsyncRead(pathname);
      }
      if (!snapshot && !borrowed && !existingPathOrUndefined(pathname)) {
        return undefined;
      }
      if (excluded || mutation) {
        sourcePin = acquireStateDatabaseHandleLease({ databasePath: pathname });
      }
      let location = snapshot?.location ?? pathname;
      if (borrowed) {
        prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
          borrowed.database.db,
          authority.assertCurrent,
        );
        location = prepared.location;
      } else if (!snapshot && (preserveArtifacts || excluded || mutation)) {
        await transport.validateFresh(context, authority);
        authority.assertCurrent();
        prepared = await prepareSqliteReadOnlyLocation(pathname, {
          preserveSourceArtifacts: preserveArtifacts,
          signal: authority.signal,
        });
        location = prepared.location;
      }
      authority.assertCurrent();
      const outcome = await transport.read(
        { context, location, checkFreshAdmission: !borrowed },
        authority,
      );
      const sourceAdmitted =
        "error" in outcome
          ? outcome.sourceAdmitted
          : outcome.value.type !== "admit" && outcome.value.sourceAdmitted;
      try {
        authority.assertCurrent();
        if (sourceAdmitted) {
          // Schema admission, including a later query failure, matches the native observation point.
          borrowed?.observe();
        }
      } catch (error) {
        if (!("error" in outcome)) {
          throw error;
        }
        acceptanceErrors.push(error);
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    };
    const errors: unknown[] = [];
    const cleanupErrors: unknown[] = [];
    let result: OpenClawStateReadReply | undefined;
    try {
      result = await read();
    } catch (error) {
      errors.push(error);
    } finally {
      producerSettled.resolve();
    }
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const taskFailure = await transport.readFailure();
    if (taskFailure && !errors.includes(taskFailure.error)) {
      errors.unshift(taskFailure.error);
    }
    // Cancellation can be the producer's error as well as its final admission result.
    errors.push(
      ...[...new Set(acceptanceErrors)].filter((error) => !errors.includes(error)),
      ...cleanupErrors,
    );
    throwSqliteLifecycleErrors(errors, "Shared-state read and cleanup failed");
    return result;
  };
  const tracked = scopes.reduceRight<() => Promise<OpenClawStateReadReply | undefined>>(
    (operation, scope) => () => scope.work.track(operation),
    run,
  );
  const maintenance = context.maintenanceScope;
  return maintenance ? maintenance.run(() => maintenance.track(tracked())) : tracked();
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
