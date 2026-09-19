import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { hasErrnoCode } from "../infra/errno.js";
import { SqliteCoordinatorError, throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import {
  retainSnapshotTempDirectory,
  retainSnapshotWork,
} from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "../infra/sqlite-readonly-location.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  PreparedSqliteReadOnlyLocation,
} from "../infra/sqlite-readonly-location.types.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationAsync,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  acquireStateDatabaseHandleLease,
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseCanonicalMutation,
} from "../infra/state-database-coordinator.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  retainOpenClawStateDatabaseForIndependentRead,
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabase,
  OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadOnlyLocation,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  existingPathOrUndefined,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";
import {
  assertRetainedReadScopeAdmission,
  bindRetainedReadScope,
  createRetainedReadScope,
  runRetainedReadScope,
} from "./openclaw-state-read-scope.js";
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

/** Opaque identity for derived facts scoped to these owned private database bytes. */
export function getActiveOpenClawStateDatabaseReadSnapshot(
  options: OpenClawStateDatabaseOptions = {},
): object | undefined {
  const pathname = resolveReadOnlyPath(options);
  const current = stateSnapshotReads.getStore();
  return current?.path === pathname ? current : undefined;
}

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
  const callerSignal = getAsyncWorkSignal();
  const controller = new AbortController();
  let closeSnapshotWork: ((reason: unknown) => void) | undefined;
  const run = async () => {
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    let admission: ReturnType<typeof captureOpenClawStateDatabaseReadAdmission>;
    let prepared: PreparedSqliteReadOnlyLocation;
    try {
      admission = captureOpenClawStateDatabaseReadAdmission(pathname);
      prepared = await prepareSqliteReadOnlyLocation(pathname, {
        preserveSourceArtifacts: isArtifactPreservingStateRead(),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `Cannot read shared state for discovery: ${pathname}. Retry after the current state operation completes. ${String(error)}`,
        { cause: error },
      );
    }
    const releaseSource = retainSnapshotTempDirectory(
      prepared.cleanupRoot ?? path.dirname(prepared.location),
    );
    const snapshot = Object.assign(
      createRetainedReadScope(pathname, admission.identity, async () => {
        releaseSource();
        if (!(await prepared.cleanupAsync())) {
          throw new Error(
            `Shared-state discovery snapshot cleanup failed: ${prepared.cleanupRoot ?? pathname}`,
          );
        }
      }),
      { location: prepared.location, env },
    );
    const lifecycle = stateSnapshotReads.run(snapshot, () => bindRetainedReadScope(snapshot));
    closeSnapshotWork = lifecycle.abort;
    const closeFromCaller = () => lifecycle.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", closeFromCaller, { once: true });
    if (callerSignal?.aborted) {
      closeFromCaller();
    }
    try {
      return await lifecycle.run(async () => {
        controller.signal.throwIfAborted();
        openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
        admission.assertCurrent();
        return await operation();
      });
    } finally {
      callerSignal?.removeEventListener("abort", closeFromCaller);
    }
  };
  return await retainSnapshotWork(run(), () => {
    controller.abort(new Error("Shared-state snapshot admission closed"));
    closeSnapshotWork?.(controller.signal.reason);
  });
}

/** The caller owns this private database and removes its files after the scope closes. */
export async function withDisposableOpenClawStateReads<T>(
  pathname: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedPath = resolveReadOnlyPath({ path: pathname });
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

function resolveReadOnlyPath(options: OpenClawStateDatabaseOptions): string {
  const pathname = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  assertRetainedReadScopeAdmission(pathname, [
    stateSnapshotReads.getStore(),
    ...(disposableStateReads.getStore() ?? []),
  ]);
  isExistingOpenClawStateSchema(pathname);
  return pathname;
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
    // Process-local terminal failures evict this handle. Persisted quarantine
    // is checked on the next physical open so hot reads do not poll metadata.
    // A newer build can migrate this file while the handle stays open, so the
    // forward-compatibility gate still runs before any reused read.
    assertStateReadSchema(opened.db, pathname);
    observeOpenClawDatabaseMaintenanceResource(opened.db);
    return { reused: true, value: operation(opened) };
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
    assertStateReadSchema(opened.database.db, pathname);
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

/** A missing pathname is not absence while this read owner can serve retained state. */
export function isOpenClawStateDatabaseDefinitelyAbsent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const pathname = resolveReadOnlyPath({ env });
    const snapshot = stateSnapshotReads.getStore();
    if (
      synchronousReadSnapshots.current?.has(pathname) ||
      (snapshot?.active && snapshot.path === pathname) ||
      openClawStateDatabaseCache.getCachedOpenClawStateDatabase(pathname)?.db.isOpen
    ) {
      return false;
    }
    try {
      lstatSync(pathname);
      return false;
    } catch (error) {
      return hasErrnoCode(error, "ENOENT");
    }
  } catch {
    // Unknown availability retains the normal reader's admission and error behavior.
    return false;
  }
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

/** Fixed reads observe committed state unless their owner explicitly selected a snapshot. */
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
  const controller = new AbortController();
  const run = async (): Promise<OpenClawStateReadReply | undefined> => {
    const producerSettled = createDeferredCore();
    const transport = createOpenClawStateReadTransport(command, (error) => controller.abort(error));
    let cleanupPending: Promise<void> | undefined;
    let transportStopped = false;
    let cleaned = false;
    let validated = false;
    const acceptanceErrors: unknown[] = [];
    let borrowed: ReturnType<typeof retainOpenClawStateDatabaseForIndependentRead>;
    let sourcePin: ReturnType<typeof acquireStateDatabaseHandleLease> | undefined;
    let prepared: AsyncPreparedSqliteReadOnlyLocation | undefined;
    let expectedIdentity: string | undefined;
    let releasePreparedSource: (() => void) | undefined;
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
        if (expectedIdentity !== undefined) {
          assertExistingDatabaseIdentity(pathname, expectedIdentity);
        }
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
          releasePreparedSource?.();
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
      let nativeSource: OpenClawStateDatabase | undefined;
      if (!snapshot) {
        if (preserveArtifacts || excluded || mutation) {
          const native = borrowOpenClawStateDatabaseForAsyncRead(pathname);
          borrowed = native;
          nativeSource = native?.database;
        } else {
          borrowed = retainOpenClawStateDatabaseForIndependentRead(pathname);
        }
      }
      if (!snapshot && !borrowed && !existingPathOrUndefined(pathname)) {
        return undefined;
      }
      if (excluded || mutation) {
        sourcePin = acquireStateDatabaseHandleLease({ databasePath: pathname });
      }
      let location = snapshot?.location ?? pathname;
      if (nativeSource) {
        prepared =
          excluded || mutation
            ? await prepareSqliteReadOnlyLocationFromOwnedDatabase(
                nativeSource.db,
                authority.assertCurrent,
              )
            : await prepareSqliteReadOnlyLocationFromOwnedDatabase(
                nativeSource.db,
                authority.assertCurrent,
                authority.signal,
                "async",
              );
        location = prepared.location;
      } else if (!snapshot && (preserveArtifacts || excluded || mutation)) {
        await transport.validateFresh(context, authority);
        authority.assertCurrent();
        prepared = await (
          excluded || mutation ? prepareSqliteReadOnlyLocation : prepareSqliteReadOnlyLocationAsync
        )(pathname, {
          preserveSourceArtifacts: preserveArtifacts,
          signal: authority.signal,
        });
        location = prepared.location;
      }
      if (!snapshot && !prepared) {
        // The native borrow protects custody, not another cursor's implicit snapshot.
        expectedIdentity = context.admission.identity.key;
      }
      if (prepared) {
        releasePreparedSource = retainSnapshotTempDirectory(
          prepared.cleanupRoot ?? path.dirname(prepared.location),
        );
      }
      authority.assertCurrent();
      const outcome = await transport.read(
        {
          context,
          location,
          checkFreshAdmission: !borrowed,
          expectedIdentity,
          snapshotRoot: prepared?.cleanupRoot,
        },
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
  return retainSnapshotWork(
    maintenance ? maintenance.run(() => maintenance.track(tracked())) : tracked(),
    () => controller.abort(new Error("Shared-state read admission closed")),
  );
}

/** Read existing shared state without creating or updating its SQLite sidecars. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): T | undefined {
  if (openStateSchemaReadAdmission) {
    return withExistingOpenClawStateDatabaseCurrentReadOnly(
      operation,
      options,
      openStateSchemaReadAdmission,
    );
  }
  return withArtifactPreservingStateReads(() =>
    withExistingOpenClawStateDatabaseReadOnly(operation, options),
  );
}

/** Publication guards need current rows, never an inherited discovery snapshot. */
export function withExistingOpenClawStateDatabaseCurrentReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  return stateSnapshotReads.exit(() => {
    // Maintenance admission belongs to a fresh private reader, never a cached writer.
    if (!openStateSchemaReadAdmission) {
      const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
      if (reused.reused) {
        return reused.value;
      }
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
      openStateSchemaReadAdmission,
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
