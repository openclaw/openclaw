import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { coerceErrorMessage, extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayLockDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  classifyGatewayLockProcessNamespace,
  GATEWAY_OWNER_HEARTBEAT_MS,
  GatewayLockNamespaceError,
  type LockPayload,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import {
  ensureOwnerDirectory,
  removeCreatedProjectionDirectories,
  resolveGatewayStateOwnerPath,
  type StateOwnerDirectoryIdentity,
} from "./gateway-state-owner-directory.js";
import {
  assertPersistedStateDatabaseAccessAllowed,
  StateDatabaseAdmissionPendingError,
} from "./gateway-state-owner-record.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerUrl,
  resolveRuntimeWorkerThreadExecArgv,
} from "./runtime-worker-url.js";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

export { resolveGatewayStateOwnerPath } from "./gateway-state-owner-directory.js";

export type StateDatabaseSchemaLease = {
  readonly path: string;
  assertCurrent(this: void): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  run<T>(this: void, operation: () => T): T;
  release(this: void): void;
};

export type GatewayStateProjection = {
  readonly lockPath: string;
  readonly verifiedAt: number | undefined;
  verifyStillHeld(): boolean;
  retain(): GatewayStateProjection;
  release(): void;
};

/** Carry the same physical sidecar through relocation and accepted schema work. */
export function createGatewayStateProjection(
  lock: ReturnType<typeof acquireFileLockSync>,
): GatewayStateProjection {
  let references = 1;
  let verifiedAt: number | undefined;
  const verify = () => {
    verifiedAt = undefined;
    if (!lock.verifyStillHeld()) {
      return false;
    }
    verifiedAt = performance.now();
    return true;
  };
  const reference = (): GatewayStateProjection => {
    let released = false;
    return {
      lockPath: lock.lockPath,
      get verifiedAt() {
        return released ? undefined : verifiedAt;
      },
      verifyStillHeld: () => !released && verify(),
      retain() {
        if (released || !verify()) {
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
  kind: "process" | "schema";
  payload: LockPayload;
  projectionPath?: string;
  getProjection?: () => GatewayStateProjection | undefined;
  locks: Set<StateOwnerFile>;
  heartbeat?: { worker: Worker; paths: Set<string> };
  projectionDirectories: StateOwnerDirectoryIdentity[];
  // Retained leases keep custody after this stops new admission.
  accepting: boolean;
  verifiedAt?: number;
};

function hasPhysicalOwnership(owner: ProcessOwner): boolean {
  return verifyOwnerLock(owner, owner.locks.values().next().value);
}

function verifyOwnerLock(owner: ProcessOwner, lock: StateOwnerFile | undefined): boolean {
  owner.verifiedAt = undefined;
  if (!lock?.verifyStillHeld()) {
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
  owner.verifiedAt = performance.now();
  return true;
}

const log = createSubsystemLogger("gateway/state");

function startOwnerHeartbeat(owner: ProcessOwner) {
  const locks: Record<string, string> = {};
  for (const lock of owner.locks) {
    locks[lock.lockPath] = fs.readFileSync(lock.lockPath, "utf8");
    if (!lock.verifyStillHeld()) {
      throw new Error("OpenClaw state ownership is no longer current");
    }
  }
  const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat);
  const worker = createCpuTrackedWorker(url, {
    workerData: { locks, intervalMs: GATEWAY_OWNER_HEARTBEAT_MS },
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
  });
  worker.on("error", (error) =>
    log.warn(
      `Gateway ownership heartbeat stopped: ${coerceErrorMessage(error)}; restart the Gateway to renew ownership.`,
    ),
  );
  worker.unref();
  return { worker, paths: new Set(Object.keys(locks)) };
}

// Only explicit reads reuse proof for one second; overdue dispatch verifies
// synchronously, so event-loop stalls cannot extend the read ownership window.
const READ_OWNERSHIP_MAX_AGE_MS = 1000;

const readOwnerPaths = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateReadOwnerPaths"),
  () => new Map<string, { pathname: string; owner: ProcessOwner; expiresAt: number }>(),
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
  const entry = schemaOwners.getStore()?.get(resolveGatewayStateOwnerPath(databasePath));
  if (!entry) {
    return undefined;
  }
  if (!entry.active) {
    throw new Error("State schema maintenance scope is no longer current");
  }
  entry.lease.assertCurrent();
  return entry.lease;
}

export const GatewayStateOwnerContentionError = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateOwnerContentionError"),
  () =>
    class StateOwnerContentionError extends Error {
      constructor(
        public readonly databasePath: string,
        public override readonly cause?: unknown,
      ) {
        super(
          `OpenClaw state database is busy at ${databasePath}. Wait for the other OpenClaw process to finish, then retry. If it persists, run \`openclaw gateway status\` and check for other OpenClaw processes using the same state directory. A running Gateway can hold this ownership until it stops; stop it through its service manager or original terminal before retrying.`,
        );
        this.name = "GatewayStateOwnerContentionError";
      }
    },
);
export type GatewayStateOwnerContentionError = InstanceType<
  typeof GatewayStateOwnerContentionError
>;

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

function defaultPayload(databasePath: string): LockPayload {
  const stateDir = resolveOpenClawStateDirForDatabasePath(databasePath);
  const startTime = getFileLockProcessStartTime(process.pid);
  return {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: new Date().toISOString(),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    role: "sqlite-maintenance",
    processNamespace: readGatewayLockProcessNamespace(),
    ...(startTime === null ? {} : { startTime }),
  };
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
  const stale = ({ payload: value }: { payload: unknown }) => {
    const namespace = classifyGatewayLockProcessNamespace(
      isRecord(value) ? value.processNamespace : undefined,
      pathname,
    );
    if (namespace === "unknown") {
      throw new GatewayLockNamespaceError();
    }
    if (namespace === "dead") {
      return true;
    }
    return isLockOwnerDefinitelyStale({
      payload: isRecord(value) ? { pid: value.pid, starttime: value.startTime } : null,
    });
  };
  if (busyTimeoutMs > 0) {
    try {
      const previous = parseGatewayLockPayload(fs.readFileSync(pathname, "utf8"));
      if (
        previous &&
        !stale({ payload: previous }) &&
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
        parsePayload: parseGatewayLockPayload,
        shouldReclaim: stale,
        shouldRemoveStaleLock: stale,
      });
    } catch (error) {
      const code = extractErrorCode(error);
      if (code === "ENOENT" && !retriedMissingParent) {
        // A finished reset may remove an empty parent before exclusive create.
        // No lock or protected operation exists yet; keep the original wait budget.
        retriedMissingParent = true;
        ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
        continue;
      }
      if (code === "file_lock_timeout" || code === "file_lock_stale") {
        throw new GatewayStateOwnerContentionError(databasePath, error);
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
        owners.get(pathname) !== owner ||
        resolveGatewayStateOwnerPath(databasePath) !== pathname ||
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
      inherited.set(pathname, entry);
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
        if (owner.locks.size === 0 && owners.get(pathname) === owner) {
          // Final physical release also ends its worker; retained schema leases keep both alive.
          owner.heartbeat?.worker.postMessage("stop", []);
          void owner.heartbeat?.worker.terminate();
          owner.accepting = false;
          owners.delete(pathname);
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
  const pathname = resolveGatewayStateOwnerPath(params.databasePath);
  if (owners.has(pathname)) {
    throw new GatewayStateOwnerContentionError(params.databasePath);
  }
  const payload = params.payload
    ? { ...params.payload, ownerId: params.payload.ownerId ?? randomUUID() }
    : defaultPayload(params.databasePath);
  const owner: ProcessOwner = {
    kind: "process",
    payload,
    projectionPath: params.projectionPath,
    getProjection: params.getProjection,
    locks: new Set(),
    projectionDirectories: [],
    accepting: true,
  };
  const lock = acquireOwnerFile(params.databasePath, pathname, payload);
  owner.locks.add(lock);
  readOwnerPaths.clear();
  owners.set(pathname, owner);
  const lease = leaseForFile(pathname, lock, owner);
  try {
    owner.heartbeat = startOwnerHeartbeat(owner);
    lease.assertCurrent();
  } catch (error) {
    return runWithSqliteCleanup(lease, "state process ownership verification", () => {
      throw error;
    });
  }
  return {
    path: pathname,
    assertCurrent() {
      if (!owner.accepting || owners.get(pathname) !== owner) {
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
  const pathname = resolveGatewayStateOwnerPath(databasePath);
  let owner = owners.get(pathname);
  if (owner && (!owner.accepting || !hasPhysicalOwnership(owner))) {
    throw new GatewayStateOwnerContentionError(databasePath);
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
      kind: "schema",
      payload,
      projectionPath,
      locks: new Set([lock, projection]),
      projectionDirectories,
      accepting: true,
    };
    owners.set(pathname, owner);
  }
  const lease = leaseForFile(pathname, lock, owner, projection);
  try {
    const heartbeat = (owner.heartbeat ??= startOwnerHeartbeat(owner));
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
  const pathname = resolveGatewayStateOwnerPath(databasePath);
  const owner = owners.get(pathname);
  if (!owner || owner.kind !== "process") {
    return undefined;
  }
  if (!owner.accepting || !hasPhysicalOwnership(owner)) {
    throw new GatewayStateOwnerContentionError(databasePath);
  }
  assertStateDatabaseAccessAllowed(databasePath);
  return acquireStateDatabaseSchemaLease(databasePath);
}

/** Startup recovery requires this process's retained Gateway root, not a schema loan. */
export function hasActiveGatewayStateOwner(databasePath: string): boolean {
  const owner = owners.get(resolveGatewayStateOwnerPath(databasePath));
  return (
    owner?.kind === "process" &&
    owner.accepting &&
    (owner.payload.role ?? "gateway") === "gateway" &&
    hasPhysicalOwnership(owner)
  );
}

/** Capture registered process custody; a PID or copied lock payload grants no authority. */
export function captureGatewayStateOwner(databasePath: string) {
  const pathname = resolveGatewayStateOwnerPath(databasePath);
  const owner = owners.get(pathname);
  if (!owner || owner.kind !== "process") {
    return undefined;
  }
  const assertCurrent = () => {
    if (
      owners.get(pathname) !== owner ||
      !owner.accepting ||
      resolveGatewayStateOwnerPath(databasePath) !== pathname ||
      !hasPhysicalOwnership(owner) ||
      (owner.getProjection && !owner.getProjection()?.verifyStillHeld())
    ) {
      throw new GatewayStateOwnerContentionError(databasePath);
    }
    assertStateDatabaseAccessAllowed(databasePath);
  };
  assertCurrent();
  return { ownerId: owner.payload.ownerId, role: owner.payload.role ?? "gateway", assertCurrent };
}

function hasRecentVerification(verifiedAt: number | undefined, now: number): boolean {
  return verifiedAt !== undefined && now - verifiedAt < READ_OWNERSHIP_MAX_AGE_MS;
}

/** Only explicit reads reuse recent physical verification; mutations always check freshly. */
export function assertStateDatabaseReadAllowed(databasePath: string): void {
  if (owners.size === 0) {
    assertStateDatabaseAccessAllowed(databasePath);
    return;
  }
  const key = path.resolve(databasePath);
  const now = performance.now();
  const cached = readOwnerPaths.get(key);
  const projection = cached?.owner.getProjection?.();
  if (
    cached &&
    now < cached.expiresAt &&
    owners.get(cached.pathname) === cached.owner &&
    cached.owner.accepting &&
    hasRecentVerification(cached.owner.verifiedAt, now) &&
    (!cached.owner.getProjection ||
      (projection && hasRecentVerification(projection.verifiedAt, now)))
  ) {
    return;
  }
  readOwnerPaths.delete(key);
  const pathname = resolveGatewayStateOwnerPath(databasePath);
  const owner = owners.get(pathname);
  const role = owner?.payload.role ?? "gateway";
  if (
    !owner ||
    owner.kind !== "process" ||
    !owner.accepting ||
    (role !== "gateway" && role !== "agent-embedded")
  ) {
    // Maintenance/schema authority and foreign owners keep their existing fresh checks.
    assertStateDatabaseAccessAllowed(databasePath);
    return;
  }
  if (
    !hasPhysicalOwnership(owner) ||
    (owner.getProjection && !owner.getProjection()?.verifyStillHeld())
  ) {
    throw new Error(
      `OpenClaw state ownership at ${databasePath} could not be verified; retry after maintenance finishes.`,
    );
  }
  readOwnerPaths.set(key, { pathname, owner, expiresAt: now + READ_OWNERSHIP_MAX_AGE_MS });
}

/** Ordinary SQLite access observes maintenance; it never borrows schema authority. */
export function assertStateDatabaseAccessAllowed(
  databasePath: string,
  captured?: {
    maintenanceScope?: OpenClawDatabaseMaintenanceScope;
    schemaLease?: StateDatabaseSchemaLease;
  },
): void {
  const assertMaintenance = () => {
    const schemaLease = captured ? captured.schemaLease : getStateDatabaseSchemaLease(databasePath);
    if (schemaLease) {
      schemaLease.assertDatabaseAccess(databasePath);
      return;
    }
    const scope = captured ? captured.maintenanceScope : getOpenClawDatabaseMaintenanceScope();
    if (!scope) {
      throw new Error(
        `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.`,
      );
    }
    scope.assertDatabaseAccess(databasePath);
  };
  const pathname = resolveGatewayStateOwnerPath(databasePath);
  const local = owners.get(pathname);
  const unavailable = `OpenClaw state ownership at ${databasePath} could not be verified; retry after maintenance finishes.`;
  if (local) {
    if (!hasPhysicalOwnership(local)) {
      throw new Error(unavailable);
    }
    const role = local.payload.role ?? "gateway";
    if (!local.accepting || (role !== "gateway" && role !== "agent-embedded")) {
      assertMaintenance();
    }
    return;
  }
  assertPersistedStateDatabaseAccessAllowed({
    databasePath,
    ownerPath: pathname,
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
