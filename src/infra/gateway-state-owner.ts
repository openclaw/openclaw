import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { resolveGatewayLockDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  describeGatewayLockHolder,
  type LockPayload,
  LockPayloadSchema,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import {
  ensureOwnerDirectory,
  resolveStateOwnerIdentity,
  removeCreatedProjectionDirectories,
  type StateOwnerDirectoryIdentity,
} from "./gateway-state-owner-directory.js";
import { startGatewayStateOwnerHeartbeat } from "./gateway-state-owner-heartbeat.js";
import {
  assertPersistedStateDatabaseAccessAllowed,
  defaultPayload,
  GatewayStateOwnerContentionError,
  isGatewayStateOwnerDefinitelyStale,
  StateDatabaseAdmissionPendingError,
  StateDatabaseMaintenanceScopeError,
} from "./gateway-state-owner-record.js";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";

export { GatewayStateOwnerContentionError } from "./gateway-state-owner-record.js";

export type StateDatabaseSchemaLease = {
  readonly path: string;
  assertCurrent(this: void): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  run<T>(this: void, operation: () => T): T;
  release(this: void): void;
};

export type GatewayStateProjection = {
  readonly lockPath: string;
  verifyStillHeld(): boolean;
  retain(): GatewayStateProjection;
  release(): void;
};

/** Carry the same physical sidecar through relocation and accepted schema work. */
export function createGatewayStateProjection(
  lock: ReturnType<typeof acquireFileLockSync>,
): GatewayStateProjection {
  let references = 1;
  const reference = (): GatewayStateProjection => {
    let released = false;
    return {
      lockPath: lock.lockPath,
      verifyStillHeld: () => !released && lock.verifyStillHeld(),
      retain() {
        if (released || !lock.verifyStillHeld()) {
          throw new Error("Gateway state projection is no longer current");
        }
        references += 1;
        return reference();
      },
      release() {
        readOwnerPaths.clear();
        if (released) {
          return;
        }
        if (references === 1) {
          lock.release();
        }
        references -= 1;
        released = true;
      },
    };
  };
  return reference();
}

type StateOwnerFile = Pick<GatewayStateProjection, "lockPath" | "verifyStillHeld" | "release">;
type ProcessOwner = {
  key: string;
  path: string;
  kind: "process" | "schema";
  payload: LockPayload;
  projectionPath?: string;
  getProjection?: () => GatewayStateProjection | undefined;
  locks: Set<StateOwnerFile>;
  heartbeat?: ReturnType<typeof startGatewayStateOwnerHeartbeat>;
  lost: AbortController;
  projectionDirectories: StateOwnerDirectoryIdentity[];
  // Retained leases keep custody after this stops new admission.
  accepting: boolean;
};

function hasPhysicalOwnership(owner: ProcessOwner): boolean {
  try {
    return verifyOwnerLock(owner, owner.locks.values().next().value);
  } catch (error) {
    // Observers report their own unavailable-read contract; lease assertions keep the loss cause.
    if (owner.lost.signal.aborted) {
      return false;
    }
    throw error;
  }
}

function verifyOwnerLock(owner: ProcessOwner, lock: StateOwnerFile | undefined): boolean {
  owner.lost.signal.throwIfAborted();
  owner.heartbeat?.inspect();
  owner.lost.signal.throwIfAborted();
  if (!lock) {
    return false;
  }
  if (!lock.verifyStillHeld()) {
    loseOwner(
      owner,
      new Error(`${lock.lockPath}: no longer current; lock removed/replaced; restart the Gateway.`),
    );
    return false;
  }
  const projection = owner.getProjection?.();
  if (projection && owner.heartbeat && !owner.heartbeat.paths.has(projection.lockPath)) {
    const raw = fs.readFileSync(projection.lockPath, "utf8");
    if (!projection.verifyStillHeld()) {
      return false;
    }
    owner.heartbeat.worker.postMessage([projection.lockPath, raw], []);
    owner.heartbeat.paths.add(projection.lockPath);
  }
  return true;
}

const log = createSubsystemLogger("gateway/state");

function loseOwner(owner: ProcessOwner, error: Error) {
  if (owner.lost.signal.aborted) {
    return;
  }
  owner.accepting = false;
  readOwnerPaths.clear();
  owner.heartbeat?.stop();
  log.error(error.message);
  owner.lost.abort(error);
}

const readOwnerPaths = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateReadOwnerPaths"),
  () => new Map<string, ProcessOwner>(),
);

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateOwners"),
  () => new Map<string, ProcessOwner>(),
);

const schemaOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseSchemaOwners"),
  () =>
    new AsyncLocalStorage<
      ReadonlyMap<string, { lease: StateDatabaseSchemaLease; active: boolean }>
    >(),
);

/** The synchronous lexical owner is live authority, not the existence of its sidecar. */
export function getStateDatabaseSchemaLease(
  databasePath: string,
): StateDatabaseSchemaLease | undefined {
  const entry = schemaOwners.getStore()?.get(resolveStateOwnerIdentity(databasePath).key);
  if (entry && !entry.active) {
    throw new Error("State schema maintenance scope is no longer current");
  }
  entry?.lease.assertCurrent();
  return entry?.lease;
}

/** Retry cold admission only; the same budget covers opening and its first unentered write. */
export function withStateDatabaseColdAdmission<T>(
  params: { databasePath: string; busyTimeoutMs: number; canRetry?: () => boolean },
  open: (remainingBusyTimeoutMs: () => number) => T,
): T {
  const budget = normalizeSqliteNonNegativeInteger(params.busyTimeoutMs, "busyTimeoutMs");
  const deadline = performance.now() + budget;
  const canonical = resolveIdentityPathViaExistingAncestorSync(params.databasePath);
  const remainingBusyTimeoutMs = () => Math.max(0, Math.ceil(deadline - performance.now()));
  const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (;;) {
    try {
      assertStateDatabaseAccessAllowed(params.databasePath);
      return open(remainingBusyTimeoutMs);
    } catch (error) {
      if (
        !(error instanceof StateDatabaseAdmissionPendingError) ||
        resolveIdentityPathViaExistingAncestorSync(error.databasePath) !== canonical ||
        params.canRetry?.() === false
      ) {
        throw error;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw error;
      }
      Atomics.wait(waiting, 0, 0, Math.min(10, remaining));
    }
  }
}

/** State cleanup preserves this owner until destructive work and native handles settle. */
export function resolveGatewayStateOwnerPath(databasePath: string): string {
  return resolveStateOwnerIdentity(databasePath).ownerPath;
}

function acquireOwnerFile(
  databasePath: string,
  pathname: string,
  payload: LockPayload,
  busyTimeoutMs = 0,
  createdDirectories?: ProcessOwner["projectionDirectories"],
) {
  const deadline = performance.now() + busyTimeoutMs;
  ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
  const observed: { holder: LockPayload | null } = { holder: null };
  const stale = ({ payload: value }: { payload: unknown }) => {
    observed.holder = LockPayloadSchema.safeParse(value).data ?? null;
    return isGatewayStateOwnerDefinitelyStale(observed.holder, pathname);
  };
  if (busyTimeoutMs > 0) {
    try {
      const previous = (observed.holder = parseGatewayLockPayload(
        fs.readFileSync(pathname, "utf8"),
      ));
      if (
        previous &&
        !isGatewayStateOwnerDefinitelyStale(previous, pathname) &&
        (previous.pid === process.pid ||
          ((previous.role ?? "gateway") === "gateway" && isPidAlive(previous.pid)))
      ) {
        // A serving Gateway cannot lend schema authority. An unregistered local
        // holder may need this host to service grants, so it cannot be waited on.
        throw new GatewayStateOwnerContentionError(databasePath);
      }
    } catch (error) {
      if (extractErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  for (let retriedMissingParent = false; ;) {
    try {
      return acquireFileLockSync(pathname, {
        lockPath: pathname,
        retry:
          busyTimeoutMs > 0
            ? { factor: 1.25, minTimeout: 10, maxTimeout: 25, randomize: false }
            : { retries: 0 },
        timeoutMs: Math.max(0, Math.ceil(deadline - performance.now())),
        staleMs: Infinity,
        staleRecovery: "remove-if-unchanged",
        reentrantOwner: payload.ownerId,
        payload: () => payload,
        // Reclamation validates foreign payloads; held custody compares exact bytes and token.
        shouldReclaim: stale,
        shouldRemoveStaleLock: stale,
      });
    } catch (error) {
      const code = extractErrorCode(error);
      if (code === "ENOENT" && !retriedMissingParent) {
        // Final lease cleanup can remove the parent before exclusive creation.
        // Recreate it once without extending the original contention budget.
        retriedMissingParent = true;
        ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
        continue;
      }
      if (code === "file_lock_timeout" || code === "file_lock_stale") {
        const { holder } = observed;
        const holderDetail = describeGatewayLockHolder(
          holder ?? {},
          pathname,
          holder && isPidAlive(holder.pid) ? "live" : "unknown",
        );
        throw new GatewayStateOwnerContentionError(
          databasePath,
          error,
          holderDetail,
          holder ? { pid: holder.pid, role: holder.role } : undefined,
        );
      }
      throw error;
    }
  }
}

function leaseForFile(
  pathname: string,
  lock: ReturnType<typeof acquireFileLockSync>,
  owner: ProcessOwner,
  projection?: StateOwnerFile,
): StateDatabaseSchemaLease {
  let released = false;
  const holdsPhysicalLease = () =>
    verifyOwnerLock(owner, lock) && (!projection || projection.verifyStillHeld());
  const lease: StateDatabaseSchemaLease = {
    path: pathname,
    assertCurrent() {
      if (released || !holdsPhysicalLease()) {
        throw new Error("OpenClaw state ownership is no longer current");
      }
    },
    assertDatabaseAccess(databasePath) {
      if (
        released ||
        owners.get(owner.key) !== owner ||
        resolveStateOwnerIdentity(databasePath).key !== owner.key ||
        !holdsPhysicalLease()
      ) {
        throw new Error("OpenClaw state maintenance does not own this database");
      }
    },
    run(operation) {
      lease.assertCurrent();
      readOwnerPaths.clear();
      const inherited = new Map(schemaOwners.getStore());
      const entry = { lease, active: true };
      inherited.set(owner.key, entry);
      try {
        return schemaOwners.run(inherited, operation);
      } finally {
        entry.active = false;
        readOwnerPaths.clear();
      }
    },
    release() {
      readOwnerPaths.clear();
      if (!released) {
        projection?.release();
        lock.release();
        released = true;
        owner.locks.delete(lock);
        if (projection) {
          owner.locks.delete(projection);
        }
        if (owner.locks.size === 0 && owners.get(owner.key) === owner) {
          // Final physical release also ends its worker; retained schema leases keep both alive.
          owner.heartbeat?.stop();
          owner.accepting = false;
          owners.delete(owner.key);
        }
      }
      // A failed directory cleanup remains retryable after physical lock release.
      if (owner.locks.size === 0) {
        removeCreatedProjectionDirectories(owner.projectionDirectories);
      }
    },
  };
  return lease;
}

/** One root owns startup or maintenance; only its registered custody can lend schema access. */
export function acquireGatewayStateOwner(params: {
  databasePath: string;
  payload?: LockPayload;
  projectionPath?: string;
  getProjection?: () => GatewayStateProjection | undefined;
}): StateDatabaseSchemaLease {
  const identity = resolveStateOwnerIdentity(params.databasePath);
  const pathname = identity.ownerPath;
  const held = owners.get(identity.key);
  if (held) {
    throw new GatewayStateOwnerContentionError(
      params.databasePath,
      undefined,
      describeGatewayLockHolder(held.payload, pathname, "live"),
      { pid: held.payload.pid, role: held.payload.role },
    );
  }
  const payload = params.payload
    ? {
        ...(params.payload.role === "sqlite-maintenance"
          ? defaultPayload(params.databasePath)
          : {}),
        ...params.payload,
        ownerId: params.payload.ownerId ?? randomUUID(),
      }
    : defaultPayload(params.databasePath);
  const owner: ProcessOwner = {
    key: identity.key,
    path: pathname,
    kind: "process",
    payload,
    projectionPath: params.projectionPath,
    getProjection: params.getProjection,
    locks: new Set(),
    projectionDirectories: [],
    lost: new AbortController(),
    accepting: true,
  };
  const lock = acquireOwnerFile(params.databasePath, pathname, payload);
  owner.locks.add(lock);
  readOwnerPaths.clear();
  owners.set(owner.key, owner);
  const lease = leaseForFile(pathname, lock, owner);
  try {
    owner.heartbeat = startGatewayStateOwnerHeartbeat(owner.locks, (error) =>
      loseOwner(owner, error),
    );
    lease.assertCurrent();
  } catch (error) {
    return runWithSqliteCleanup(lease, "state process ownership verification", () => {
      throw error;
    });
  }
  return {
    path: pathname,
    assertCurrent() {
      owner.lost.signal.throwIfAborted();
      if (!owner.accepting || owners.get(owner.key) !== owner) {
        throw new Error("OpenClaw state process owner is no longer current");
      }
      lease.assertCurrent();
    },
    assertDatabaseAccess: lease.assertDatabaseAccess,
    run: lease.run,
    release() {
      owner.accepting = false;
      lease.release();
    },
  };
}

/** Accepted schema work retains the sidecar even when its process owner stops lending. */
export function acquireStateDatabaseSchemaLease(
  databasePath: string,
  options: { busyTimeoutMs?: number } = {},
): StateDatabaseSchemaLease {
  readOwnerPaths.clear();
  const identity = resolveStateOwnerIdentity(databasePath);
  let owner = owners.get(identity.key);
  const pathname = owner?.path ?? identity.ownerPath;
  if (owner && (!owner.accepting || !hasPhysicalOwnership(owner))) {
    throw new GatewayStateOwnerContentionError(databasePath, owner.lost.signal.reason);
  }
  if (owner) {
    assertStateDatabaseAccessAllowed(databasePath);
  }
  const payload = owner?.payload ?? {
    ...defaultPayload(databasePath),
    stateOwnerKind: "schema" as const,
  };
  let lock: ReturnType<typeof acquireFileLockSync>;
  const projectionDirectories: ProcessOwner["projectionDirectories"] = [];
  try {
    lock = acquireOwnerFile(
      databasePath,
      pathname,
      payload,
      owner ? 0 : (options.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
      projectionDirectories,
    );
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      try {
        assertStateDatabaseAccessAllowed(databasePath);
      } catch (currentOwnerError) {
        if (currentOwnerError instanceof StateDatabaseAdmissionPendingError) {
          throw currentOwnerError;
        }
      }
    }
    throw error;
  }
  const projectionPath =
    owner?.projectionPath ??
    path.join(
      resolveGatewayLockDir(
        resolveOpenClawStateDirForDatabasePath(
          resolveIdentityPathViaExistingAncestorSync(databasePath),
        ),
      ),
      "gateway.state.lock",
    );
  let projection: StateOwnerFile;
  try {
    // The process owner retains its exact sidecar even when its root path moves.
    projection =
      owner?.getProjection?.()?.retain() ??
      acquireOwnerFile(
        databasePath,
        projectionPath,
        {
          ...payload,
          role: payload.role === "gateway" ? "gateway" : "agent-embedded",
        },
        0,
        projectionDirectories,
      );
  } catch (error) {
    return runWithSqliteCleanup(
      {
        release() {
          lock.release();
          removeCreatedProjectionDirectories(projectionDirectories);
        },
      },
      "state schema projection admission",
      () => {
        throw error;
      },
    );
  }
  if (owner) {
    owner.locks.add(lock);
    owner.locks.add(projection);
    owner.projectionDirectories.push(...projectionDirectories);
  } else {
    owner = {
      key: identity.key,
      path: pathname,
      kind: "schema",
      payload,
      projectionPath,
      locks: new Set([lock, projection]),
      projectionDirectories,
      lost: new AbortController(),
      accepting: true,
    };
    owners.set(owner.key, owner);
  }
  const lease = leaseForFile(pathname, lock, owner, projection);
  try {
    const heartbeat = (owner.heartbeat ??= startGatewayStateOwnerHeartbeat(owner.locks, (error) =>
      loseOwner(owner, error),
    ));
    const raw = fs.readFileSync(projection.lockPath, "utf8");
    lease.assertCurrent();
    heartbeat.worker.postMessage([projection.lockPath, raw], []);
    heartbeat.paths.add(projection.lockPath);
    return lease;
  } catch (error) {
    return runWithSqliteCleanup(lease, "state schema ownership verification", () => {
      throw error;
    });
  }
}

/** A nested maintenance scope can retain only an already-held process root for its exact database. */
export function tryBorrowGatewayStateOwner(
  databasePath: string,
): StateDatabaseSchemaLease | undefined {
  const owner = owners.get(resolveStateOwnerIdentity(databasePath).key);
  if (!owner || owner.kind !== "process") {
    return undefined;
  }
  if (!owner.accepting || !hasPhysicalOwnership(owner)) {
    throw new GatewayStateOwnerContentionError(databasePath, owner.lost.signal.reason);
  }
  assertStateDatabaseAccessAllowed(databasePath);
  return acquireStateDatabaseSchemaLease(databasePath);
}

/** Startup recovery requires this process's retained Gateway root, not a schema loan. */
export function hasActiveGatewayStateOwner(databasePath: string): boolean {
  const owner = owners.get(resolveStateOwnerIdentity(databasePath).key);
  return (
    owner?.kind === "process" &&
    owner.accepting &&
    (owner.payload.role ?? "gateway") === "gateway" &&
    hasPhysicalOwnership(owner)
  );
}

/** Capture registered process custody; a PID or copied lock payload grants no authority. */
export function captureGatewayStateOwner(databasePath: string) {
  const key = resolveStateOwnerIdentity(databasePath).key;
  const owner = owners.get(key);
  if (!owner || owner.kind !== "process") {
    return undefined;
  }
  const assertCurrent = () => {
    owner.lost.signal.throwIfAborted();
    if (
      owners.get(key) !== owner ||
      !owner.accepting ||
      resolveStateOwnerIdentity(databasePath).key !== key ||
      (owner.getProjection && !owner.getProjection()?.verifyStillHeld())
    ) {
      throw new GatewayStateOwnerContentionError(databasePath);
    }
    assertStateDatabaseAccessAllowed(databasePath);
  };
  assertCurrent();
  return {
    ownerId: owner.payload.ownerId,
    role: owner.payload.role ?? "gateway",
    assertCurrent,
    signal: owner.lost.signal,
  };
}

/** Reads within an admission reuse process custody; the next admission verifies the lock. */
export function assertStateDatabaseReadAllowed(
  databasePath: string,
  captured?: Parameters<typeof assertStateDatabaseAccessAllowed>[1],
): void {
  assertStateDatabaseReadAtOwnerPath(databasePath, captured);
}

function assertStateDatabaseReadAtOwnerPath(
  databasePath: string,
  captured: Parameters<typeof assertStateDatabaseAccessAllowed>[1],
  prepared?: ReturnType<typeof resolveStateOwnerIdentity>,
): void {
  if (owners.size === 0) {
    assertStateDatabaseAccessAtOwnerPath(
      databasePath,
      prepared ?? resolveStateOwnerIdentity(databasePath),
      captured,
    );
    return;
  }
  const key = path.resolve(databasePath);
  const cached = readOwnerPaths.get(key);
  if (cached?.accepting) {
    return;
  }
  readOwnerPaths.delete(key);
  const identity = prepared ?? resolveStateOwnerIdentity(databasePath);
  const owner = owners.get(identity.key);
  const role = owner?.payload.role ?? "gateway";
  if (
    !owner ||
    owner.kind !== "process" ||
    !owner.accepting ||
    (role !== "gateway" && role !== "agent-embedded")
  ) {
    // Maintenance/schema authority and foreign owners keep their existing fresh checks.
    assertStateDatabaseAccessAtOwnerPath(databasePath, identity, captured);
    return;
  }
  if (
    !hasPhysicalOwnership(owner) ||
    (owner.getProjection && !owner.getProjection()?.verifyStillHeld())
  ) {
    // A recorded loss already names the lock and the restart step; rethrow it unwrapped.
    owner.lost.signal.throwIfAborted();
    throw new Error(
      `OpenClaw state ownership at ${databasePath} was lost: owner lock was removed or replaced; restart the Gateway.`,
    );
  }
  readOwnerPaths.set(key, owner);
}

/** Ordinary SQLite access observes maintenance; it never borrows schema authority. */
export function assertStateDatabaseAccessAllowed(
  databasePath: string,
  captured?: {
    maintenanceScope?: OpenClawDatabaseMaintenanceScope;
    schemaLease?: Pick<StateDatabaseSchemaLease, "assertDatabaseAccess">;
  },
): void {
  assertStateDatabaseAccessAtOwnerPath(
    databasePath,
    resolveStateOwnerIdentity(databasePath),
    captured,
  );
}

/** Retained handles keep their admitted paths; reopening captures a fresh identity. */
export function captureStateDatabaseAccess(databasePath: string) {
  const identity = resolveStateOwnerIdentity(databasePath);
  const { canonicalPath } = identity;
  return {
    canonicalPath,
    assertAccessAllowed(captured?: Parameters<typeof assertStateDatabaseAccessAllowed>[1]) {
      assertStateDatabaseAccessAtOwnerPath(canonicalPath, identity, captured);
    },
    assertReadAllowed(captured?: Parameters<typeof assertStateDatabaseAccessAllowed>[1]) {
      assertStateDatabaseReadAtOwnerPath(canonicalPath, captured, identity);
    },
  };
}

function assertStateDatabaseAccessAtOwnerPath(
  databasePath: string,
  identity: ReturnType<typeof resolveStateOwnerIdentity>,
  captured: Parameters<typeof assertStateDatabaseAccessAllowed>[1],
): void {
  const assertMaintenance = () => {
    const schemaLease = captured ? captured.schemaLease : getStateDatabaseSchemaLease(databasePath);
    if (schemaLease) {
      schemaLease.assertDatabaseAccess(databasePath);
      return;
    }
    const scope = captured ? captured.maintenanceScope : getOpenClawDatabaseMaintenanceScope();
    if (!scope) {
      throw new StateDatabaseMaintenanceScopeError(databasePath);
    }
    scope.assertDatabaseAccess(databasePath);
  };
  const local = owners.get(identity.key);
  if (local) {
    if (!hasPhysicalOwnership(local)) {
      local.lost.signal.throwIfAborted();
      throw new Error(
        `OpenClaw state ownership at ${databasePath} was lost: owner lock was removed or replaced; restart the Gateway.`,
      );
    }
    const role = local.payload.role ?? "gateway";
    if (!local.accepting || (role !== "gateway" && role !== "agent-embedded")) {
      assertMaintenance();
    }
    return;
  }
  assertPersistedStateDatabaseAccessAllowed({
    databasePath,
    ownerPath: identity.ownerPath,
    assertMaintenance,
  });
}

/** Cleanup must compete with local roots too; it cannot borrow a live Gateway's authority. */
export function tryAcquireGatewayStateOwner(databasePath: string): StateDatabaseSchemaLease | null {
  try {
    return acquireGatewayStateOwner({ databasePath });
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      return null;
    }
    throw error;
  }
}
