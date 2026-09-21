// Coordinates Gateway presence and shared-state lifecycle operations outside removable state.
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import type { MessagePort } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { beginLifecycleWriteCustody } from "./lifecycle-write-custody.js";
import {
  createSqliteLifecycleAggregateError,
  ensurePrivateSqliteCoordinatorDirectory,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
  type SqliteCoordinatorLease,
  tryAcquireExclusiveSqliteCoordinator,
  tryAcquireSharedSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { withSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";
import {
  attachCoordinatorDelegate,
  attachLifecycleCoordinatorDelegate,
  createCoordinatorDelegate,
  acquireDelegatedLifecycleCoordinator,
} from "./state-database-coordinator-delegate.js";
import {
  StateDatabaseCoordinatorContentionError,
  StateSchemaMutationConflictError,
} from "./state-database-coordinator-errors.js";
import {
  resolveLifecycleCoordinatorBase,
  buildLifecycleCoordinatorPath,
  resolveLifecycleCoordinatorPath,
  type CoordinatorFamily,
} from "./state-database-coordinator-paths.js";
export {
  StateDatabaseCoordinatorContentionError,
  StateSchemaMutationConflictError,
} from "./state-database-coordinator-errors.js";

type HeldCoordinator = {
  coordinator: SqliteCoordinatorLease;
  references: number;
  keepAlive: boolean;
  gatewayOwners: number;
  gatewayDelegates: Set<Int32Array>;
};

type SourceReadScope = {
  active: boolean;
  mutation?: boolean;
  assertCurrent: () => void;
  pin: () => { release: () => void };
  snapshot?: (signal?: AbortSignal) => Promise<PreparedSqliteReadOnlyLocation>;
  snapshots?: Promise<unknown>[];
};
export type StateDatabaseCoordinatorRuntime = Readonly<{
  directory: string;
  keepAlive: boolean;
}>;
// Retained brokers and freshly loaded callers must borrow the same live owners and scopes.
const {
  heldCoordinators,
  sourceReadScopes,
  canonicalWriteScopes,
  coordinatorRuntimeDirectories,
  gatewaySchemaScopes,
} = resolveGlobalSingleton(Symbol.for("openclaw.stateDatabaseCoordinator"), () => ({
  heldCoordinators: new Map<string, HeldCoordinator>(),
  sourceReadScopes: new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>(),
  canonicalWriteScopes: new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>(),
  coordinatorRuntimeDirectories: new AsyncLocalStorage<StateDatabaseCoordinatorRuntime>(),
  gatewaySchemaScopes: new AsyncLocalStorage<
    ReadonlyMap<string, { active: boolean; assertCurrent: () => void }>
  >(),
}));

type CoordinatorOptions = {
  databasePath: string;
  coordinatorPath?: string;
  runtimeDirectory?: string;
  uid?: number;
  busyTimeoutMs?: number;
  keepAlive?: boolean;
};

type StateDatabaseCoordinatorLease = {
  path: string;
  // A remaining reference can accept custody without closing the native handle.
  readonly closed: boolean;
  release: () => void;
};

export function resolveStateLifecycleRuntimeDirectory(): string {
  const captured = coordinatorRuntimeDirectories.getStore();
  if (captured !== undefined) {
    return captured.directory;
  }
  return process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "locks")
    : "/tmp";
}

/** Capture the directory owner's retention policy before crossing an async or worker boundary. */
export function captureStateDatabaseCoordinatorRuntime(): StateDatabaseCoordinatorRuntime {
  const captured = coordinatorRuntimeDirectories.getStore();
  return captured
    ? { ...captured }
    : { directory: resolveStateLifecycleRuntimeDirectory(), keepAlive: true };
}

export function withStateDatabaseCoordinatorRuntimeDirectory<T>(
  runtime: string | StateDatabaseCoordinatorRuntime,
  operation: () => T,
): T {
  const captured =
    typeof runtime === "string" ? { directory: runtime, keepAlive: false } : { ...runtime };
  return coordinatorRuntimeDirectories.run(captured, operation);
}

export function resolveStateDatabaseCoordinatorPath(params: {
  databasePath: string;
  runtimeDirectory: string;
  uid: number | undefined;
}): string {
  return resolveLifecycleCoordinatorPath("state-lifecycle", params);
}

function acquireLifecycleCoordinator(
  family: CoordinatorFamily,
  params: CoordinatorOptions,
  { keepAlive = false, gatewayOwner = false }: { keepAlive?: boolean; gatewayOwner?: boolean } = {},
): StateDatabaseCoordinatorLease {
  const coordinatorPath =
    params.coordinatorPath ??
    resolveLifecycleCoordinatorPath(family, {
      databasePath: params.databasePath,
      runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
      uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    });
  if (family === "state-lifecycle") {
    const delegate = acquireDelegatedLifecycleCoordinator(coordinatorPath);
    if (delegate) {
      return delegate;
    }
  }
  let held = heldCoordinators.get(coordinatorPath);
  if (held) {
    if (held.references === 0) {
      throw new SqliteCoordinatorError(
        `${family} coordinator cleanup is pending; retry its close before reacquiring`,
      );
    }
    held.references += 1;
    held.keepAlive &&= keepAlive;
  } else {
    ensurePrivateSqliteCoordinatorDirectory(path.dirname(coordinatorPath), `${family} coordinator`);
    const coordinator = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, {
      busyTimeoutMs: params.busyTimeoutMs,
      keepAlive,
    });
    if (!coordinator) {
      throw new StateDatabaseCoordinatorContentionError(family);
    }
    held = {
      coordinator,
      references: 1,
      keepAlive,
      gatewayOwners: 0,
      gatewayDelegates: new Set(),
    };
    heldCoordinators.set(coordinatorPath, held);
  }
  if (gatewayOwner) {
    held.gatewayOwners += 1;
  }

  const owner = held;
  let relinquished = false;
  let settled = false;
  return {
    path: coordinatorPath,
    get closed() {
      return settled || (relinquished && owner.coordinator.closed);
    },
    release: () => {
      if (settled) {
        return;
      }
      if (!relinquished) {
        relinquished = true;
        if (gatewayOwner) {
          owner.gatewayOwners -= 1;
          if (owner.gatewayOwners === 0) {
            for (const delegate of owner.gatewayDelegates) {
              Atomics.store(delegate, 0, 0);
            }
          }
        }
        owner.references -= 1;
      }
      if (owner.references > 0) {
        settled = true;
        return;
      }
      try {
        owner.coordinator.release(owner.keepAlive ? undefined : { keepAlive: false });
      } catch (error) {
        throw new SqliteCoordinatorError(`failed to release ${family} coordinator`, error);
      } finally {
        if (owner.coordinator.closed) {
          settled = true;
          if (heldCoordinators.get(coordinatorPath) === owner) {
            heldCoordinators.delete(coordinatorPath);
          }
        }
      }
    },
  };
}

export function acquireGatewayLifecycleCoordinator(params: CoordinatorOptions) {
  return acquireLifecycleCoordinator("gateway-lifecycle", params, { gatewayOwner: true });
}

/** Maintenance lends schema access only to jobs admitted through its lexical resource scope. */
export function acquireGatewayMaintenanceCoordinator(params: CoordinatorOptions) {
  const lease = acquireLifecycleCoordinator("gateway-lifecycle", params);
  return {
    ...lease,
    get closed() {
      return lease.closed;
    },
    createSchemaFenceDelegate(this: void, target: GatewaySchemaFenceDelegateParams) {
      if (resolveGatewaySchemaFencePath(target) !== lease.path) {
        return undefined;
      }
      if (lease.closed) {
        throw new SqliteCoordinatorError("Gateway maintenance coordinator is closed");
      }
      const retained = acquireLifecycleCoordinator("gateway-lifecycle", {
        ...target,
        coordinatorPath: lease.path,
      });
      const live = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      Atomics.store(live, 0, 1);
      return createCoordinatorDelegate(
        { actorId: target.actorId, coordinatorPath: lease.path },
        live,
        retained,
        () => Atomics.store(live, 0, 0),
        "Gateway maintenance schema delegate",
      );
    },
  };
}

type GatewaySchemaFenceDelegateParams = Pick<
  CoordinatorOptions,
  "databasePath" | "runtimeDirectory" | "uid"
> & { actorId: string };

function resolveGatewaySchemaFencePath(
  params: Pick<CoordinatorOptions, "databasePath" | "runtimeDirectory" | "uid">,
): string {
  return resolveLifecycleCoordinatorPath("gateway-lifecycle", {
    databasePath: params.databasePath,
    runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
    uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
  });
}

/** Legacy cleanup must exclude new admission without borrowing a process-local owner. */
export function tryAcquireGatewayLifecycleCleanupCoordinator(
  params: Pick<CoordinatorOptions, "databasePath" | "runtimeDirectory" | "uid">,
): SqliteCoordinatorLease | null {
  const pathname = resolveGatewaySchemaFencePath(params);
  ensurePrivateSqliteCoordinatorDirectory(path.dirname(pathname), "gateway-lifecycle coordinator");
  return tryAcquireExclusiveSqliteCoordinator(pathname, { busyTimeoutMs: 0 });
}

/** True only while this process retains the native Gateway-role coordinator. */
export function hasGatewayLifecycleCoordinator(
  params: Pick<CoordinatorOptions, "databasePath" | "runtimeDirectory" | "uid">,
): boolean {
  return (heldCoordinators.get(resolveGatewaySchemaFencePath(params))?.gatewayOwners ?? 0) > 0;
}

/** The broker owns this pin until backend close acknowledges or worker exit joins. */
export function tryCreateGatewaySchemaFenceDelegate(params: GatewaySchemaFenceDelegateParams) {
  if (heldCoordinators.size === 0) {
    return undefined;
  }
  const coordinatorPath = resolveGatewaySchemaFencePath(params);
  const owner = heldCoordinators.get(coordinatorPath);
  if (!owner || owner.gatewayOwners === 0) {
    return undefined;
  }
  const live = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // Retain the actual native owner; a transferable message is not a new owner.
  const retained = acquireLifecycleCoordinator("gateway-lifecycle", {
    ...params,
    coordinatorPath,
  });
  Atomics.store(live, 0, 1);
  owner.gatewayDelegates.add(live);
  return createCoordinatorDelegate(
    { actorId: params.actorId, coordinatorPath },
    live,
    retained,
    () => {
      Atomics.store(live, 0, 0);
      owner.gatewayDelegates.delete(live);
    },
    "Gateway schema delegate",
  );
}

/** Install before entering native SQLite; transaction callbacks remain synchronous. */
export async function attachGatewaySchemaFenceDelegate(
  port: MessagePort,
  params: GatewaySchemaFenceDelegateParams,
) {
  const coordinatorPath = resolveGatewaySchemaFencePath(params);
  const delegate = await attachCoordinatorDelegate(
    port,
    { actorId: params.actorId, coordinatorPath },
    "Gateway schema delegate",
  );
  return {
    run<T>(operation: () => T): T {
      const scope = {
        active: true,
        assertCurrent() {
          try {
            delegate.assertCurrent();
          } catch (error) {
            throw new StateSchemaMutationConflictError(params.databasePath, error);
          }
        },
      };
      const scopes = new Map(gatewaySchemaScopes.getStore());
      scopes.set(coordinatorPath, scope);
      return runWithSqliteCoordinator(
        {
          release: () => {
            scope.active = false;
          },
        },
        "Gateway schema delegate scope",
        () => gatewaySchemaScopes.run(scopes, operation),
      );
    },
    close: delegate.close,
  };
}

/** Each broker job retains its parent's physical lifecycle lease through settlement. */
export function tryCreateStateLifecycleDelegate(
  params: Pick<GatewaySchemaFenceDelegateParams, "databasePath" | "actorId">,
) {
  if (heldCoordinators.size === 0) {
    return undefined;
  }
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath: params.databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  if (!heldCoordinators.has(coordinatorPath)) {
    return undefined;
  }
  const retained = acquireStateDatabaseCoordinator({ databasePath: params.databasePath });
  const live = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.store(live, 0, 1);
  return createCoordinatorDelegate(
    { actorId: params.actorId, coordinatorPath },
    live,
    retained,
    () => {
      Atomics.store(live, 0, 0);
    },
    "State lifecycle delegate",
  );
}

export async function attachStateLifecycleDelegate(
  port: MessagePort,
  params: GatewaySchemaFenceDelegateParams,
) {
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath: params.databasePath,
    runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
    uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
  });
  return attachLifecycleCoordinatorDelegate(port, { actorId: params.actorId, coordinatorPath });
}

/** Borrow only a coordinator already owned by this process. The returned
 * reference must remain held until the participating worker has exited. */
export function retainHeldStateDatabaseCoordinator(databasePath: string) {
  const pathname = resolveStateDatabaseCoordinatorPath({
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  return heldCoordinators.has(pathname)
    ? acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 })
    : undefined;
}

const shouldKeepStateCoordinatorAlive = (params: CoordinatorOptions) =>
  params.keepAlive !== false &&
  params.coordinatorPath === undefined &&
  params.runtimeDirectory === undefined &&
  (coordinatorRuntimeDirectories.getStore()?.keepAlive ?? true);

export function acquireStateDatabaseCoordinator(params: CoordinatorOptions) {
  // Caller-owned locations must remain removable immediately after release,
  // including on Windows where an idle SQLite handle blocks unlink.
  const keepAlive = shouldKeepStateCoordinatorAlive(params);
  // Lifecycle ownership is reentrant for nested transactions. File publication
  // is not: even this process must refuse before ownership probes touch SQLite.
  const base = resolveLifecycleCoordinatorBase({
    databasePath: params.databasePath,
    runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
    uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
  });
  const handlesPath = buildLifecycleCoordinatorPath("state-handles", base);
  const writeScope = canonicalWriteScopes.getStore()?.get(handlesPath);
  if (writeScope) {
    if (!writeScope.active) {
      throw new SqliteCoordinatorError("SQLite binding write scope is no longer current");
    }
    writeScope.assertCurrent();
    // Authority callbacks can change paths; resolve again after their checks.
    return acquireLifecycleCoordinator("state-lifecycle", params, {
      keepAlive: shouldKeepStateCoordinatorAlive(params),
    });
  } else if (heldCoordinators.has(handlesPath)) {
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
  return acquireLifecycleCoordinator(
    "state-lifecycle",
    {
      ...params,
      coordinatorPath:
        params.coordinatorPath ?? buildLifecycleCoordinatorPath("state-lifecycle", base),
    },
    { keepAlive },
  );
}

/** Fence schema mutation against another process's live Gateway owner. */
export function withStateSchemaFence<T>(
  params: Pick<CoordinatorOptions, "databasePath" | "runtimeDirectory" | "uid">,
  operation: () => T,
): T {
  const delegatePath = resolveGatewaySchemaFencePath(params);
  const delegate = gatewaySchemaScopes.getStore()?.get(delegatePath);
  if (delegate) {
    if (!delegate.active) {
      throw new SqliteCoordinatorError("Gateway schema delegate scope is closed");
    }
    delegate.assertCurrent();
    return runWithSqliteCoordinator({ release() {} }, "state schema mutation", operation);
  }
  let coordinator: ReturnType<typeof acquireGatewayLifecycleCoordinator>;
  try {
    // Never wait while the caller holds the state-lifecycle coordinator. A
    // running Gateway must win immediately so lock ordering cannot deadlock.
    coordinator = acquireLifecycleCoordinator("gateway-lifecycle", {
      ...params,
      coordinatorPath: delegatePath,
      busyTimeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof StateDatabaseCoordinatorContentionError) {
      throw new StateSchemaMutationConflictError(params.databasePath, error);
    }
    throw error;
  }
  return runWithSqliteCoordinator(coordinator, "state schema mutation", operation);
}

function resolveStateDatabaseHandleReadContext(params: CoordinatorOptions) {
  const pathname =
    params.coordinatorPath ??
    resolveLifecycleCoordinatorPath("state-handles", {
      databasePath: params.databasePath,
      runtimeDirectory: params.runtimeDirectory ?? resolveStateLifecycleRuntimeDirectory(),
      uid: params.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    });
  const writeScope = canonicalWriteScopes.getStore()?.get(pathname);
  if (writeScope) {
    if (!writeScope.active) {
      throw new SqliteCoordinatorError("SQLite binding write scope is no longer current");
    }
    writeScope.assertCurrent();
    return { pathname, scope: writeScope };
  }
  const sourceScope = sourceReadScopes.getStore()?.get(pathname);
  if (sourceScope?.active) {
    sourceScope.assertCurrent();
    return { pathname, scope: sourceScope };
  }
  if (heldCoordinators.has(pathname)) {
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
  return { pathname, scope: undefined };
}

/** Validate the caller's local authority; the executing copy worker acquires the native lease. */
export function assertStateDatabaseSourceReadContext(databasePath: string): void {
  resolveStateDatabaseHandleReadContext({ databasePath });
}

/** A live cached connection excludes file publication, not other cached connections. */
export function acquireStateDatabaseHandleLease(params: CoordinatorOptions) {
  const { pathname, scope } = resolveStateDatabaseHandleReadContext(params);
  if (scope) {
    return scope.pin();
  }
  return withSqliteInspectionOperation("coordinator", () => {
    ensurePrivateSqliteCoordinatorDirectory(path.dirname(pathname), "state-handles coordinator");
    const coordinator = tryAcquireSharedSqliteCoordinator(pathname, {
      busyTimeoutMs: params.busyTimeoutMs,
      keepAlive: shouldKeepStateCoordinatorAlive(params),
    });
    if (!coordinator) {
      throw new StateDatabaseCoordinatorContentionError("state-handles");
    }
    return coordinator;
  });
}

/** Acquire only after closing local cached owners under the state lifecycle gate. */
export function acquireStateDatabaseHandleExclusion(params: CoordinatorOptions) {
  const coordinator = acquireLifecycleCoordinator("state-handles", params);
  const owner = heldCoordinators.get(coordinator.path);
  // Only the returned owner can create internal read pins. A second public
  // acquisition must not borrow another task's process-local exclusion.
  if (!owner || owner.references !== 1) {
    coordinator.release();
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
  let released = false;
  const assertCurrent = () => {
    if (released || heldCoordinators.get(coordinator.path) !== owner) {
      throw new SqliteCoordinatorError("SQLite source exclusion is no longer current");
    }
  };
  const pin = () => {
    assertCurrent();
    return acquireLifecycleCoordinator("state-handles", {
      ...params,
      coordinatorPath: coordinator.path,
    });
  };
  return {
    assertCurrent,
    release() {
      released = true;
      coordinator.release();
    },
    assertNoPins() {
      assertCurrent();
      if (owner.references !== 1) {
        throw new SqliteCoordinatorError("SQLite mutation left a participating handle open");
      }
    },
    assertMutationCurrent(this: void) {
      const scope = canonicalWriteScopes.getStore()?.get(coordinator.path);
      if (!scope?.active || !scope.mutation) {
        throw new SqliteCoordinatorError("SQLite canonical mutation scope is closed");
      }
      scope.assertCurrent();
    },
    async runWithCanonicalMutation<T>(
      assertAuthority: () => void,
      operation: () => Promise<T>,
      snapshot: (
        assertCurrent: () => void,
        signal?: AbortSignal,
      ) => Promise<PreparedSqliteReadOnlyLocation>,
    ): Promise<T> {
      const retained = pin();
      const snapshots: Promise<unknown>[] = [];
      const scope: SourceReadScope = {
        active: true,
        mutation: true,
        snapshots,
        assertCurrent: () => {
          assertCurrent();
          assertAuthority();
        },
        pin,
      };
      const scopes = new Map(canonicalWriteScopes.getStore());
      scopes.set(coordinator.path, scope);
      scope.snapshot = (signal) =>
        snapshot(() => {
          if (!scope.active) {
            throw new SqliteCoordinatorError("SQLite mutation inspection scope is closed");
          }
          scope.assertCurrent();
        }, signal);
      const releaseCustody = beginLifecycleWriteCustody("coordinator-write");
      try {
        scope.assertCurrent();
        const result = await canonicalWriteScopes.run(scopes, operation);
        scope.assertCurrent();
        return result;
      } finally {
        // Close admission first, then join any snapshot that escaped its caller.
        // An escaped operation cannot use this context after the owner returns.
        scope.active = false;
        await Promise.allSettled(snapshots);
        releaseCustody();
        retained.release();
      }
    },
    assertDrainedDuringMutation() {
      assertCurrent();
      if (owner.references !== 2) {
        throw new SqliteCoordinatorError("SQLite inspection requires drained source handles");
      }
    },
    // Synchronous admission only. Inherited async contexts cannot continue
    // canonical writes after this callback returns, even after fence release.
    runWithCanonicalWrites<T>(this: void, assertAuthority: () => void, operation: () => T): T {
      const retained = pin();
      const scope: SourceReadScope = {
        active: true,
        assertCurrent: () => {
          assertCurrent();
          assertAuthority();
        },
        pin,
      };
      const scopes = new Map(canonicalWriteScopes.getStore());
      scopes.set(coordinator.path, scope);
      try {
        // Preserve even an invalid asynchronous result for the owning cache
        // boundary to drain after this synchronous admission has been revoked.
        return runWithSqliteCoordinator(retained, "SQLite binding write scope", () => {
          scope.assertCurrent();
          return { result: canonicalWriteScopes.run(scopes, operation) };
        }).result;
      } finally {
        scope.active = false;
      }
    },
    async runWithSourceReads<T>(
      this: void,
      operation: (assertCurrent: () => void) => Promise<T>,
    ): Promise<T> {
      const retained = pin();
      const scope: SourceReadScope = { active: true, assertCurrent, pin };
      const scopes = new Map(sourceReadScopes.getStore());
      scopes.set(coordinator.path, scope);
      let result: T;
      try {
        result = await sourceReadScopes.run(scopes, () => operation(assertCurrent));
        assertCurrent();
      } catch (error) {
        scope.active = false;
        try {
          retained.release();
        } catch (releaseError) {
          throw createSqliteLifecycleAggregateError(
            [error, releaseError],
            "SQLite excluded read and release both failed",
            error,
          );
        }
        throw error;
      }
      scope.active = false;
      retained.release();
      return result;
    },
  };
}

function resolveSourceScopePath(databasePath: string): string {
  return resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
}

/** Only a live process-local exclusion owner may copy its already-drained source. */
export function hasStateDatabaseSourceExclusion(databasePath: string): boolean {
  const pathname = resolveSourceScopePath(databasePath);
  const scope = sourceReadScopes.getStore()?.get(pathname);
  if (!scope?.active) {
    return false;
  }
  scope.assertCurrent();
  return true;
}

/** Capture this exact excluded read interval before asynchronous preparation. */
export function prepareStateDatabaseSourceExclusion(
  databasePath: string,
): (() => void) | undefined {
  const pathname = resolveSourceScopePath(databasePath);
  const scope = sourceReadScopes.getStore()?.get(pathname);
  if (!scope) {
    return undefined;
  }
  const assertCurrent = () => {
    if (!scope.active || sourceReadScopes.getStore()?.get(pathname) !== scope) {
      throw new SqliteCoordinatorError("SQLite excluded read scope is closed or no longer current");
    }
    scope.assertCurrent();
  };
  assertCurrent();
  return assertCurrent;
}

/** Capture the exact task-local mutation interval, never just its physical owner. */
export function prepareStateDatabaseCanonicalMutation(
  databasePath: string,
): (() => void) | undefined {
  const pathname = resolveSourceScopePath(databasePath);
  const scope = canonicalWriteScopes.getStore()?.get(pathname);
  if (!scope?.mutation) {
    return undefined;
  }
  const assertCurrent = () => {
    if (!scope.active || canonicalWriteScopes.getStore()?.get(pathname) !== scope) {
      throw new SqliteCoordinatorError(
        "SQLite canonical mutation scope is closed or no longer current",
      );
    }
    scope.assertCurrent();
  };
  assertCurrent();
  return assertCurrent;
}

/** The mutation owner alone supplies private snapshots while its native source
 * may still be open. This never authorizes a child process or a source reopen. */
export function prepareStateDatabaseMutationSnapshot(databasePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const pathname = resolveSourceScopePath(databasePath);
  const scope = canonicalWriteScopes.getStore()?.get(pathname);
  if (!scope?.mutation) {
    return undefined;
  }
  if (!scope.active || !scope.snapshot || !scope.snapshots) {
    throw new SqliteCoordinatorError("SQLite mutation inspection scope is closed");
  }
  scope.assertCurrent();
  const pending = prepareSingleFlightSqliteSnapshot(
    databasePath,
    "canonical-mutation",
    (flightSignal) => scope.snapshot!(flightSignal),
    signal,
    {
      trackProducer: (producer) => scope.snapshots!.push(producer),
    },
  );
  void pending.catch(() => undefined);
  return pending;
}
