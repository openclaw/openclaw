import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayLockDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  type GatewayLockRole,
  type LockPayload,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import { applyPrivateModeSync } from "./private-mode.js";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

export type StateDatabaseSchemaLease = {
  readonly path: string;
  assertCurrent(this: void): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  run<T>(this: void, operation: () => T): T;
  release(this: void): void;
};

type ProcessOwner = {
  kind: "process" | "schema";
  payload: LockPayload;
  projectionPath?: string;
  locks: Set<ReturnType<typeof acquireFileLockSync>>;
  projectionDirectories: { path: string; dev: bigint; ino: bigint }[];
  // Retained leases keep custody after this stops new admission.
  accepting: boolean;
};

function hasPhysicalOwnership(owner: ProcessOwner): boolean {
  return owner.locks.values().next().value?.verifyStillHeld() ?? false;
}

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

const StateDatabaseAdmissionPendingError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseAdmissionPendingError"),
  () =>
    class extends Error {
      constructor(
        readonly databasePath: string,
        message: string,
      ) {
        super(message);
      }
    },
);

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
  const canonical = resolveIdentityPathViaExistingAncestorSync(databasePath);
  const uid = process.getuid?.();
  const directory =
    process.platform === "win32"
      ? path.join(
          os.homedir(),
          "AppData",
          "Local",
          "OpenClaw",
          "locks",
          uid === undefined ? "openclaw-state-owners" : `openclaw-state-owners-${uid}`,
        )
      : resolveGatewayLockDir(resolveOpenClawStateDirForDatabasePath(canonical));
  return path.join(
    resolveIdentityPathViaExistingAncestorSync(directory),
    `state.${sha256HexPrefixCore(canonical, 16)}.lock`,
  );
}

function ensureOwnerDirectory(
  directory: string,
  created?: ProcessOwner["projectionDirectories"],
): void {
  const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (firstCreated && created) {
    // Windows mkdir returns a namespaced path even when its input has no prefix.
    const boundary = path.toNamespacedPath(firstCreated);
    const directories: ProcessOwner["projectionDirectories"] = [];
    for (let current = directory; ;) {
      const { dev, ino } = fs.lstatSync(current, { bigint: true });
      directories.push({ path: current, dev, ino });
      if (path.toNamespacedPath(current) === boundary) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("Created state ownership directory is outside its expected ancestry");
      }
      current = parent;
    }
    for (const entry of directories) {
      const previous = created.findIndex((candidate) => candidate.path === entry.path);
      if (previous < 0) {
        created.push(entry);
      } else {
        created[previous] = entry;
      }
    }
  }
  const observed = fs.lstatSync(directory);
  const uid = process.getuid?.();
  if (!observed.isDirectory() || (uid !== undefined && observed.uid !== uid)) {
    throw new Error("State ownership directory must be a user-owned real directory");
  }
  if (process.platform !== "win32" && (observed.mode & 0o7777) !== 0o700) {
    applyPrivateModeSync(directory, 0o700);
    if ((fs.lstatSync(directory).mode & 0o077) !== 0) {
      throw new Error("State ownership directory permissions are not private");
    }
  }
}

function removeCreatedProjectionDirectories(
  directories: ProcessOwner["projectionDirectories"],
): void {
  let directory = directories[0];
  while (directory) {
    try {
      const observed = fs.lstatSync(directory.path, { bigint: true });
      if (
        observed.isDirectory() &&
        observed.dev === directory.dev &&
        observed.ino === directory.ino
      ) {
        fs.rmdirSync(directory.path);
      }
    } catch (error) {
      const code = extractErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error;
      }
    }
    directories.shift();
    directory = directories[0];
  }
}

function defaultPayload(
  databasePath: string,
  role: GatewayLockRole = "sqlite-maintenance",
): LockPayload {
  const stateDir = resolveOpenClawStateDirForDatabasePath(databasePath);
  const startTime = getFileLockProcessStartTime(process.pid);
  return {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: new Date().toISOString(),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    role,
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
  projection?: ReturnType<typeof acquireFileLockSync>,
): StateDatabaseSchemaLease {
  let released = false;
  const lease: StateDatabaseSchemaLease = {
    path: pathname,
    assertCurrent() {
      if (released || !lock.verifyStillHeld() || (projection && !projection.verifyStillHeld())) {
        throw new Error("OpenClaw state ownership is no longer current");
      }
    },
    assertDatabaseAccess(databasePath) {
      if (
        released ||
        owners.get(pathname) !== owner ||
        resolveGatewayStateOwnerPath(databasePath) !== pathname ||
        !lock.verifyStillHeld() ||
        (projection && !projection.verifyStillHeld())
      ) {
        throw new Error("OpenClaw state maintenance does not own this database");
      }
    },
    run(operation) {
      lease.assertCurrent();
      const inherited = new Map(schemaOwners.getStore());
      const entry = { lease, active: true };
      inherited.set(pathname, entry);
      try {
        return schemaOwners.run(inherited, operation);
      } finally {
        entry.active = false;
      }
    },
    release() {
      if (!released) {
        projection?.release();
        lock.release();
        released = true;
        owner.locks.delete(lock);
        if (owner.locks.size === 0 && owners.get(pathname) === owner) {
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
}): StateDatabaseSchemaLease {
  const pathname = resolveGatewayStateOwnerPath(params.databasePath);
  if (owners.has(pathname)) {
    throw new GatewayStateOwnerContentionError(params.databasePath);
  }
  const payload = params.payload
    ? { ...params.payload, ownerId: params.payload.ownerId ?? randomUUID() }
    : defaultPayload(params.databasePath);
  const lock = acquireOwnerFile(params.databasePath, pathname, payload);
  const owner: ProcessOwner = {
    kind: "process",
    payload,
    projectionPath: params.projectionPath,
    locks: new Set([lock]),
    projectionDirectories: [],
    accepting: true,
  };
  owners.set(pathname, owner);
  const lease = leaseForFile(pathname, lock, owner);
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
  let projection: ReturnType<typeof acquireFileLockSync>;
  try {
    // Published Gateways know this sidecar, not the external owner. Retain the
    // same fs-safe reference as the root until this accepted schema work settles.
    projection = acquireOwnerFile(
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
    owner.projectionDirectories.push(...projectionDirectories);
  } else {
    owner = {
      kind: "schema",
      payload,
      projectionPath,
      locks: new Set([lock]),
      projectionDirectories,
      accepting: true,
    };
    owners.set(pathname, owner);
  }
  const lease = leaseForFile(pathname, lock, owner, projection);
  try {
    lease.assertCurrent();
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
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf8");
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw new Error(unavailable, { cause: error });
  }
  const owner = parseGatewayLockPayload(raw);
  if (!owner) {
    // Native exclusive creation precedes the payload write; cold admission may wait for publication.
    throw new StateDatabaseAdmissionPendingError(databasePath, unavailable);
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error(unavailable);
  }
  if (
    isLockOwnerDefinitelyStale({
      payload: { pid: owner.pid, starttime: owner.startTime },
    })
  ) {
    return;
  }
  // Workers share the process PID, but their schema authority still comes from
  // the host operation's retained lease and is never inferred from this record.
  if (owner.pid === process.pid && !isMainThread) {
    return;
  }
  if (!isPidAlive(owner.pid)) {
    throw new Error(unavailable);
  }
  const role = owner.role ?? "gateway";
  if (role === "gateway" || role === "agent-embedded") {
    return;
  }
  if (owner.pid === process.pid) {
    assertMaintenance();
    return;
  }
  if (owner.stateOwnerKind === "schema" && owner.role === "sqlite-maintenance") {
    throw new StateDatabaseAdmissionPendingError(
      databasePath,
      `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.`,
    );
  }
  throw new Error(
    `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.`,
  );
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
