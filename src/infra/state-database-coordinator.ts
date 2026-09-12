// Coordinates Gateway presence and shared-state lifecycle operations outside removable state.
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import {
  createSqliteLifecycleAggregateError,
  ensurePrivateSqliteCoordinatorDirectory,
  runWithSqliteCoordinator,
  SqliteCoordinatorError,
  type SqliteCoordinatorLease,
  tryAcquireExclusiveSqliteCoordinator,
  tryAcquireSharedSqliteCoordinator,
} from "./sqlite-coordinator.js";

const heldCoordinators = new Map<
  string,
  {
    coordinator: SqliteCoordinatorLease;
    references: number;
    keepAlive: boolean;
    gatewayOwners: number;
    gatewayDelegates: Set<Int32Array>;
  }
>();

type SourceReadScope = {
  active: boolean;
  mutation?: boolean;
  assertCurrent: () => void;
  pin: () => { release: () => void };
  snapshot?: () => Promise<{ location: string; cleanup: () => boolean }>;
  snapshots?: Promise<unknown>[];
};
const sourceReadScopes = new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>();
const canonicalWriteScopes = new AsyncLocalStorage<ReadonlyMap<string, SourceReadScope>>();
export type StateDatabaseCoordinatorRuntime = Readonly<{
  directory: string;
  keepAlive: boolean;
}>;
const coordinatorRuntimeDirectories = new AsyncLocalStorage<StateDatabaseCoordinatorRuntime>();
const gatewaySchemaScopes = new AsyncLocalStorage<
  ReadonlyMap<string, { active: boolean; assertCurrent: () => void }>
>();

type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle" | "state-handles";
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

export class StateDatabaseCoordinatorContentionError extends SqliteCoordinatorError {
  constructor(readonly family: CoordinatorFamily) {
    super(`another OpenClaw process owns ${family}`);
    this.name = "StateDatabaseCoordinatorContentionError";
  }
}

export class StateSchemaMutationConflictError extends SqliteCoordinatorError {
  constructor(databasePath: string, cause: unknown) {
    super(
      `OpenClaw refused shared state schema mutation at ${databasePath} because another Gateway owns that state directory. Stop that Gateway or perform the update through its managed restart path, then retry.`,
      cause,
    );
    this.name = "StateSchemaMutationConflictError";
  }
}

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

function resolveCoordinatorIdentityPath(pathname: string): string {
  const normalized = path.resolve(pathname);
  try {
    // Live paths need one native lookup, not JavaScript realpath's per-component probes.
    const resolved = path.resolve(realpathSync.native(normalized));
    // Windows native realpath corrects casing; the shipped lock hash preserves input casing.
    if (process.platform !== "win32" || resolved === normalized) {
      return resolved;
    }
  } catch {
    // Missing paths and failed lookups retain the existing ancestor resolution.
  }
  return resolvePathViaExistingAncestorSync(normalized);
}

function resolveLifecycleCoordinatorBase(params: {
  databasePath: string;
  runtimeDirectory: string;
  uid: number | undefined;
}) {
  const canonicalDatabasePath = resolveCoordinatorIdentityPath(params.databasePath);
  const canonicalRuntimeDirectory = resolveCoordinatorIdentityPath(params.runtimeDirectory);
  // The predecessor state-local coordinator shipped only in v2026.8.1-beta.2.
  // Keep one current stable runtime path; beta-only peers are not upgrade-compatible.
  const suffix =
    params.uid === undefined ? "openclaw-state-locks" : `openclaw-state-locks-${params.uid}`;
  return {
    directory: path.join(canonicalRuntimeDirectory, suffix),
    databaseHash: sha256HexPrefixCore(canonicalDatabasePath, 8),
  };
}

function buildLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  base: ReturnType<typeof resolveLifecycleCoordinatorBase>,
): string {
  return path.join(base.directory, `${family}.${base.databaseHash}.lock.sqlite`);
}

function resolveLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  params: Parameters<typeof resolveLifecycleCoordinatorBase>[0],
): string {
  return buildLifecycleCoordinatorPath(family, resolveLifecycleCoordinatorBase(params));
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

/** The broker owns this pin until backend close acknowledges or worker exit joins. */
export function tryCreateGatewaySchemaFenceDelegate(params: GatewaySchemaFenceDelegateParams) {
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
  let channel: MessageChannel | undefined;
  try {
    channel = new MessageChannel();
    channel.port1.postMessage({ actorId: params.actorId, coordinatorPath, live: live.buffer });
    channel.port1.unref();
  } catch (error) {
    Atomics.store(live, 0, 0);
    owner.gatewayDelegates.delete(live);
    channel?.port1.close();
    channel?.port2.close();
    return runWithSqliteCoordinator(retained, "Gateway schema delegate creation", () => {
      throw error;
    });
  }
  const { port1, port2 } = channel;
  let revoked = false;
  return {
    port: port2,
    get closed() {
      return revoked && retained.closed;
    },
    release() {
      if (!revoked) {
        revoked = true;
        Atomics.store(live, 0, 0);
        owner.gatewayDelegates.delete(live);
        port1.close();
        port2.close();
      }
      retained.release();
    },
  };
}

/** Install before entering native SQLite; transaction callbacks remain synchronous. */
export async function attachGatewaySchemaFenceDelegate(
  port: MessagePort,
  params: GatewaySchemaFenceDelegateParams,
) {
  const coordinatorPath = resolveGatewaySchemaFencePath(params);
  let closed = false;
  port.once("close", () => {
    closed = true;
  });
  const live = await new Promise<Int32Array>((resolve, reject) => {
    const onClose = () => {
      port.off("message", onMessage);
      reject(new SqliteCoordinatorError("Gateway schema delegate closed before admission"));
    };
    const onMessage = (message: unknown) => {
      port.off("message", onMessage);
      port.off("close", onClose);
      if (
        !isRecord(message) ||
        message.actorId !== params.actorId ||
        message.coordinatorPath !== coordinatorPath ||
        !(message.live instanceof SharedArrayBuffer) ||
        message.live.byteLength !== Int32Array.BYTES_PER_ELEMENT
      ) {
        port.close();
        reject(new SqliteCoordinatorError("Gateway schema delegate does not match its actor"));
        return;
      }
      resolve(new Int32Array(message.live));
    };
    port.once("close", onClose);
    port.once("message", onMessage);
    const queued = receiveMessageOnPort(port);
    if (queued) {
      onMessage(queued.message);
    }
  });
  port.unref();
  return {
    run<T>(operation: () => T): T {
      const scope = {
        active: true,
        assertCurrent() {
          if (closed || Atomics.load(live, 0) !== 1) {
            throw new StateSchemaMutationConflictError(
              params.databasePath,
              new SqliteCoordinatorError("Gateway schema delegate is no longer current"),
            );
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
    close() {
      closed = true;
      port.close();
    },
  };
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

/** A live cached connection excludes file publication, not other cached connections. */
export function acquireStateDatabaseHandleLease(params: CoordinatorOptions) {
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
    return writeScope.pin();
  }
  const sourceScope = sourceReadScopes.getStore()?.get(pathname);
  if (sourceScope?.active) {
    sourceScope.assertCurrent();
    return sourceScope.pin();
  }
  ensurePrivateSqliteCoordinatorDirectory(path.dirname(pathname), "state-handles coordinator");
  const coordinator = tryAcquireSharedSqliteCoordinator(pathname, {
    busyTimeoutMs: params.busyTimeoutMs,
  });
  if (!coordinator) {
    throw new StateDatabaseCoordinatorContentionError("state-handles");
  }
  return coordinator;
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
      ) => Promise<{ location: string; cleanup: () => boolean }>,
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
      scope.snapshot = () =>
        snapshot(() => {
          if (!scope.active) {
            throw new SqliteCoordinatorError("SQLite mutation inspection scope is closed");
          }
          scope.assertCurrent();
        });
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

/** Only a live process-local exclusion owner may copy its already-drained source. */
export function hasStateDatabaseSourceExclusion(databasePath: string): boolean {
  const pathname = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  const scope = sourceReadScopes.getStore()?.get(pathname);
  if (!scope?.active) {
    return false;
  }
  scope.assertCurrent();
  return true;
}

/** Capture the exact task-local mutation interval, never just its physical owner. */
export function prepareStateDatabaseCanonicalMutation(
  databasePath: string,
): (() => void) | undefined {
  const pathname = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
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
export function prepareStateDatabaseMutationSnapshot(databasePath: string) {
  const pathname = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  const scope = canonicalWriteScopes.getStore()?.get(pathname);
  if (!scope?.mutation) {
    return undefined;
  }
  if (!scope.active || !scope.snapshot || !scope.snapshots) {
    throw new SqliteCoordinatorError("SQLite mutation inspection scope is closed");
  }
  scope.assertCurrent();
  const pending = scope.snapshot();
  scope.snapshots.push(pending);
  void pending.catch(() => undefined);
  return pending;
}
