// Coordinates gateway lock files, ports, and stale owner detection.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { hasErrnoCode } from "./errno.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  type GatewayLockRole,
  type LockPayload,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import {
  readGatewayLockProcessCmdline,
  readGatewayLockProcessStartTime,
} from "./gateway-lock-process.js";
import {
  acquireGatewayOwnerLease,
  type GatewayOwnerLease,
  type GatewayOwnerSupervisor,
} from "./gateway-owner-lease.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import {
  acquireGatewayStateOwner,
  GatewayStateOwnerContentionError,
  resolveGatewayStateOwnerPath,
  tryBorrowGatewayStateOwner,
} from "./gateway-state-owner.js";

export const GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS = 5 * 60_000;
const log = createSubsystemLogger("gateway");

type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  stateDir: string;
  assertCurrent(this: void): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  releaseInTree: () => Promise<void>;
  release: () => Promise<void>;
  run<T>(operation: () => T): T;
};

export type GatewayLockIdentity = {
  pid: number;
  ownerId?: string;
  cronOwnerProjection?: "dynamic-default-v1";
  createdAt: string;
  port: number;
  startTime?: number;
};

export function isSameGatewayLockIdentity(
  previous: GatewayLockIdentity,
  current: GatewayLockIdentity,
): boolean {
  if (previous.ownerId && current.ownerId) {
    return previous.ownerId === current.ownerId;
  }
  return (
    previous.pid === current.pid &&
    previous.createdAt === current.createdAt &&
    previous.startTime === current.startTime
  );
}

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  lifecycleDeadlineMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  role?: GatewayLockRole;
  listenerMode?: "foreground" | "supervised";
  supervisor?: GatewayOwnerSupervisor | null;
  /** Override process command-line reader (testing seam). */
  readProcessCmdline?: (pid: number) => string[] | null;
  /** Override process start-identity reader (testing seam). */
  readProcessStartTime?: (pid: number) => number | null;
};

export class GatewayLockError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}

export function isGatewayLifecycleContentionError(error: unknown): boolean {
  return (
    error instanceof GatewayLockError && error.cause instanceof GatewayStateOwnerContentionError
  );
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

const CMDLINE_EXEC_TIMEOUT_MS = 1000;

function resolveGatewayOwnerStatusSync(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  readCmdline?: (pid: number) => string[] | null,
  readStartTime?: (pid: number) => number | null,
  opts: { trustUnknownCmdlineOwner?: boolean; deadlineMs?: number; signal?: AbortSignal } = {},
): LockOwnerStatus {
  const remainingTimeoutMs = () => {
    opts.signal?.throwIfAborted();
    const remaining =
      opts.deadlineMs === undefined ? CMDLINE_EXEC_TIMEOUT_MS : opts.deadlineMs - performance.now();
    if (remaining <= 0) {
      throw new GatewayLockError("Gateway lock inspection deadline expired");
    }
    return Math.max(1, Math.min(CMDLINE_EXEC_TIMEOUT_MS, Math.ceil(remaining)));
  };
  remainingTimeoutMs();
  const role = payload?.role ?? "gateway";
  if (!isPidAlive(pid)) {
    return "dead";
  }

  // Process start identity catches PID recycling even when the replacement
  // process has the same argv shape.
  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = (
      readStartTime ??
      ((ownerPid) => readGatewayLockProcessStartTime(ownerPid, platform, remainingTimeoutMs()))
    )(pid);
    remainingTimeoutMs();
    if (currentStartTime != null) {
      return currentStartTime === payloadStartTime ? "alive" : "dead";
    }
  }

  const readFn =
    readCmdline ??
    ((p: number) =>
      readGatewayLockProcessCmdline(p, platform, remainingTimeoutMs(), opts.deadlineMs));
  const identityOptions = readCmdline ? undefined : { pid };
  if (
    role === "agent-embedded" ||
    role === "sqlite-maintenance" ||
    role === "skill-workshop-apply"
  ) {
    const args = readFn(pid);
    remainingTimeoutMs();
    if (!args) {
      return "unknown";
    }
    // Embedded roles cover every direct state-writing command, including local TUI and probes.
    const identity =
      role === "agent-embedded"
        ? classifyOpenClawArgv(args, identityOptions)
        : classifyOpenClawArgv(args, {
            ...identityOptions,
            command: role === "sqlite-maintenance" ? "doctor" : "skills",
          });
    remainingTimeoutMs();
    return identity.kind === "unclassified"
      ? "unknown"
      : identity.kind === "openclaw"
        ? "alive"
        : "dead";
  }

  const args = readFn(pid);
  remainingTimeoutMs();
  if (!args) {
    // Cmdline reader unavailable or failed. On Linux legacy locks (no
    // start-time), "unknown" lets the stale-lock heuristic eventually reclaim
    // very old locks. On win32/darwin/other, conservatively assume "alive" to
    // preserve single-instance guarantees when wmic/ps is unavailable.
    return platform === "linux" || opts.trustUnknownCmdlineOwner === false ? "unknown" : "alive";
  }
  // Long-running gateways retitle themselves so macOS/BSD process inspection
  // can identify the owner after the original argv is no longer available.
  const identity = classifyOpenClawArgv(args, { command: "gateway", ...identityOptions });
  remainingTimeoutMs();
  return identity.kind === "unclassified"
    ? "unknown"
    : identity.kind === "openclaw"
      ? "alive"
      : "dead";
}

export async function resolveGatewayOwnerStatus(
  ...args: Parameters<typeof resolveGatewayOwnerStatusSync>
): Promise<LockOwnerStatus> {
  return resolveGatewayOwnerStatusSync(...args);
}

export async function readLockPayload(
  lockPath: string,
  requireInspection = false,
  signal?: AbortSignal,
): Promise<LockPayload | null> {
  try {
    const payload = parseGatewayLockPayload(
      await fs.readFile(lockPath, { encoding: "utf8", signal }),
    );
    if (requireInspection && !payload) {
      throw new GatewayLockError("Gateway lock payload could not be verified");
    }
    return payload;
  } catch (error) {
    signal?.throwIfAborted();
    if (requireInspection && !hasErrnoCode(error, "ENOENT")) {
      throw new GatewayLockError("Gateway lock inspection is unavailable", error);
    }
    return null;
  }
}

/** Read the same lock contract while a synchronous mutation admission is held. */
export function readLockPayloadSync(
  lockPath: string,
  requireInspection = false,
): LockPayload | null {
  try {
    const payload = parseGatewayLockPayload(fsSync.readFileSync(lockPath, "utf8"));
    if (requireInspection && !payload) {
      throw new GatewayLockError("Gateway lock payload could not be verified");
    }
    return payload;
  } catch (error) {
    if (requireInspection && !hasErrnoCode(error, "ENOENT")) {
      throw new GatewayLockError("Gateway lock inspection is unavailable", error);
    }
    return null;
  }
}

function shouldReclaimGatewayLock(params: {
  lockPath: string;
  payload: LockPayload | null;
  staleMs: number;
  now: () => number;
  platform: NodeJS.Platform;
  readProcessCmdline?: (pid: number) => string[] | null;
  readProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const ownerPid = params.payload?.pid;
  const ownerStatus = ownerPid
    ? resolveGatewayOwnerStatusSync(
        ownerPid,
        params.payload,
        params.platform,
        params.readProcessCmdline,
        params.readProcessStartTime,
      )
    : "unknown";
  if (ownerPid) {
    return ownerStatus === "dead";
  }
  if (params.payload?.createdAt) {
    const createdAt = Date.parse(params.payload.createdAt);
    if (Number.isFinite(createdAt) && params.now() - createdAt > params.staleMs) {
      return true;
    }
  }
  try {
    const stat = fsSync.statSync(params.lockPath);
    return params.now() - stat.mtimeMs > params.staleMs;
  } catch {
    // An unreadable lock can still belong to a healthy gateway. Fail closed.
    return false;
  }
}

export function resolveGatewayLockPaths(env: NodeJS.ProcessEnv, suppliedLockDir?: string) {
  const resolvedStateDir = resolveStateDir(env);
  const stateDir = resolveIdentityPathViaExistingAncestorSync(resolvedStateDir);
  const lockDir = suppliedLockDir ?? resolveGatewayLockDir(stateDir);
  const configPath = resolveConfigPath(env, resolvedStateDir);
  const configHash = sha256HexPrefixCore(configPath, 8);
  return {
    configLockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateDir,
    stateLockPath: path.join(lockDir, "gateway.state.lock"),
    ownerLockPath: resolveGatewayStateOwnerPath(path.join(stateDir, "state", "openclaw.sqlite")),
  };
}

type GatewayLockObservationOptions = Pick<
  GatewayLockOptions,
  "env" | "lockDir" | "platform" | "readProcessCmdline" | "readProcessStartTime" | "timeoutMs"
> & { requireInspection?: boolean; signal?: AbortSignal };

export async function readActiveGatewayLockPort(
  opts: GatewayLockObservationOptions = {},
): Promise<number | undefined> {
  return (await readActiveGatewayLockIdentity(opts))?.port;
}

export async function readActiveGatewayLockIdentity(
  opts: GatewayLockObservationOptions = {},
): Promise<GatewayLockIdentity | undefined> {
  const env = opts.env ?? process.env;
  const deadlineMs =
    opts.timeoutMs === undefined ? undefined : performance.now() + Math.max(0, opts.timeoutMs);
  const { configLockPath, stateLockPath, ownerLockPath } = resolveGatewayLockPaths(
    env,
    opts.lockDir,
  );
  const ownerIdentity = await readVerifiedGatewayLockIdentity(ownerLockPath, opts, deadlineMs);
  if (ownerIdentity) {
    return ownerIdentity;
  }
  const configIdentity = await readVerifiedGatewayLockIdentity(configLockPath, opts, deadlineMs);
  return configIdentity ?? (await readVerifiedGatewayLockIdentity(stateLockPath, opts, deadlineMs));
}

async function readVerifiedGatewayLockIdentity(
  lockPath: string,
  opts: GatewayLockObservationOptions,
  deadlineMs: number | undefined,
): Promise<GatewayLockIdentity | undefined> {
  const assertActive = () => {
    opts.signal?.throwIfAborted();
    if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
      throw new GatewayLockError("Gateway lock inspection deadline expired");
    }
  };
  assertActive();
  const payload = await readLockPayload(lockPath, opts.requireInspection, opts.signal);
  assertActive();
  if (!payload || (payload.role && payload.role !== "gateway")) {
    return undefined;
  }
  const ownerStatus = await resolveGatewayOwnerStatus(
    payload.pid,
    payload,
    opts.platform ?? process.platform,
    opts.readProcessCmdline,
    opts.readProcessStartTime,
    { trustUnknownCmdlineOwner: false, deadlineMs, signal: opts.signal },
  );
  assertActive();
  // Discovery may omit an unverifiable owner; mutation preflight must preserve unknown.
  if (
    opts.requireInspection &&
    ownerStatus !== "dead" &&
    (ownerStatus === "unknown" || !payload.port)
  ) {
    throw new GatewayLockError("Gateway lock owner identity could not be verified");
  }
  if (ownerStatus !== "alive" || !payload.port) {
    return undefined;
  }
  return {
    pid: payload.pid,
    ...(payload.ownerId ? { ownerId: payload.ownerId } : {}),
    ...(payload.cronOwnerProjection ? { cronOwnerProjection: payload.cronOwnerProjection } : {}),
    createdAt: payload.createdAt,
    port: payload.port,
    ...(payload.startTime !== undefined ? { startTime: payload.startTime } : {}),
  };
}

/** Older supported Gateways publish state-local sidecars; never start over their live owner. */
async function assertHistoricalGatewayOwnerStopped(
  paths: ReturnType<typeof resolveGatewayLockPaths>,
  opts: GatewayLockOptions,
): Promise<void> {
  for (const lockPath of [paths.stateLockPath, paths.configLockPath]) {
    const payload = await readLockPayload(lockPath, true);
    if (!payload) {
      continue;
    }
    const owner = await resolveGatewayOwnerStatus(
      payload.pid,
      payload,
      opts.platform ?? process.platform,
      opts.readProcessCmdline,
      opts.readProcessStartTime,
      { trustUnknownCmdlineOwner: false },
    );
    if (owner !== "dead") {
      throw new GatewayStateOwnerContentionError(
        path.join(paths.stateDir, "state", "openclaw.sqlite"),
      );
    }
  }
}

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const env = opts.env ?? process.env;
  if (opts.allowInTests !== true && (env.VITEST || env.NODE_ENV === "test")) {
    return null;
  }
  const role = opts.role ?? "gateway";
  const paths = resolveGatewayLockPaths(env, opts.lockDir);
  const databasePath = path.join(paths.stateDir, "state", "openclaw.sqlite");
  const now = opts.now ?? performance.now.bind(performance);
  const startedAt = now();
  const timeoutMs = resolveTimerTimeoutMs(
    opts.timeoutMs,
    role === "gateway" ? GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS : 0,
    0,
  );
  const deadlineMs = opts.lifecycleDeadlineMs ?? startedAt + timeoutMs;
  const startTime = (
    opts.readProcessStartTime ??
    ((pid) =>
      readGatewayLockProcessStartTime(
        pid,
        opts.platform ?? process.platform,
        CMDLINE_EXEC_TIMEOUT_MS,
      ))
  )(process.pid);
  const payload: LockPayload = {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: resolveTimestampMsToIsoString(Date.now()),
    configPath: paths.configPath,
    stateDir: paths.stateDir,
    role,
    ...(role === "gateway" ? { cronOwnerProjection: "dynamic-default-v1" as const } : {}),
    ...(typeof opts.port === "number" &&
    Number.isInteger(opts.port) &&
    opts.port > 0 &&
    opts.port <= 65_535
      ? { port: opts.port }
      : {}),
    ...(typeof startTime === "number" && Number.isFinite(startTime) ? { startTime } : {}),
  };
  const parentMaintenance = getOpenClawDatabaseMaintenanceScope();
  let borrowedOwner: ReturnType<typeof tryBorrowGatewayStateOwner>;
  if (role === "sqlite-maintenance" && parentMaintenance?.ownsSchemaMaintenance) {
    parentMaintenance.assertAdmission();
    borrowedOwner = tryBorrowGatewayStateOwner(databasePath);
  }
  let waited = false;
  let stateOwner: ReturnType<typeof acquireGatewayStateOwner>;
  try {
    stateOwner =
      borrowedOwner ??
      (await acquireWithWait({
        deadlineMs,
        pollIntervalMs: resolvePositiveTimerTimeoutMs(opts.pollIntervalMs, 250),
        maxPollIntervalMs: 2000,
        now,
        sleep: opts.sleep,
        acquire: async () => {
          const owner = acquireGatewayStateOwner({
            databasePath,
            payload,
            projectionPath: paths.stateLockPath,
          });
          try {
            await assertHistoricalGatewayOwnerStopped(paths, opts);
            owner.assertCurrent();
            return owner;
          } catch (error) {
            owner.release();
            throw error;
          }
        },
        shouldRetry: (error) => {
          if (!(error instanceof GatewayStateOwnerContentionError)) {
            return false;
          }
          if (!waited && deadlineMs > startedAt && role === "gateway") {
            log.warn(
              `waiting for Gateway state ownership held by another OpenClaw process, up to ${Math.ceil((deadlineMs - startedAt) / 1000)} s`,
            );
          }
          waited = true;
          return true;
        },
      }));
  } catch (error) {
    const waitHint =
      waited && role === "gateway"
        ? `; waited ${Math.round(now() - startedAt)}ms for Gateway state ownership`
        : "";
    const message = `failed to acquire gateway state ownership${waitHint}`;
    const detail =
      error instanceof GatewayStateOwnerContentionError
        ? `${message}: ${error.message}. Stop the Gateway or wait for the current OpenClaw operation to finish, then retry.`
        : message;
    throw new GatewayLockError(detail, error);
  }
  if (waited && role === "gateway") {
    log.info(`Gateway state ownership acquired after ${((now() - startedAt) / 1000).toFixed(1)} s`);
  }
  let projection: ReturnType<typeof acquireFileLockSync> | undefined;
  const assertStateOwnerCurrent = () => {
    if (borrowedOwner) {
      parentMaintenance?.assertOwnerCurrent();
    }
    stateOwner.assertCurrent();
    if (projection && !projection.verifyStillHeld()) {
      throw new Error("OpenClaw Gateway ownership projection is no longer current");
    }
  };
  const assertDatabaseAccess = (requestedPath: string) => {
    assertStateOwnerCurrent();
    stateOwner.assertDatabaseAccess(requestedPath);
  };
  const resources =
    role === "sqlite-maintenance"
      ? createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: assertStateOwnerCurrent,
          assertDatabaseAccess,
        })
      : undefined;
  let ownerLease: GatewayOwnerLease | undefined;
  try {
    // Shipped Gateways discover this PID sidecar before starting. Synchronous
    // schema work retains the same fs-safe owner through its final reference.
    const shouldReclaim = (previous: LockPayload | null) =>
      shouldReclaimGatewayLock({
        lockPath: paths.stateLockPath,
        payload: previous,
        staleMs: opts.staleMs ?? 30_000,
        now: Date.now,
        platform: opts.platform ?? process.platform,
        readProcessCmdline: opts.readProcessCmdline,
        readProcessStartTime: opts.readProcessStartTime,
      });
    if (!borrowedOwner) {
      projection = acquireFileLockSync(paths.stateLockPath, {
        lockPath: paths.stateLockPath,
        timeoutMs: 0,
        retry: { retries: 0 },
        staleRecovery: "remove-if-unchanged",
        reentrantOwner: payload.ownerId,
        payload: () => (role === "gateway" ? payload : { ...payload, role: "agent-embedded" }),
        parsePayload: parseGatewayLockPayload,
        shouldReclaim: ({ payload: previous }) => shouldReclaim(previous as LockPayload | null),
        shouldRemoveStaleLock: ({ payload: previous }) =>
          shouldReclaim(previous as LockPayload | null),
      });
    }
    assertStateOwnerCurrent();
    if (role === "gateway" && opts.listenerMode && opts.port) {
      ownerLease = acquireGatewayOwnerLease({
        env,
        port: opts.port,
        mode: opts.listenerMode,
        supervisor: opts.supervisor ?? null,
        owner: payload.ownerId,
      });
      await ownerLease.ready;
    }
  } catch (error) {
    await ownerLease?.release();
    projection?.release();
    stateOwner.release();
    throw new GatewayLockError("failed to acquire gateway state ownership", error);
  }
  let drained: Promise<void> | undefined;
  const releaseInTree = () =>
    (drained ??= Promise.resolve()
      .then(async () => {
        await resources?.close();
        projection?.release();
        projection = undefined;
      })
      .catch((error: unknown) => {
        drained = undefined;
        throw error;
      }));
  let released: Promise<void> | undefined;
  return {
    lockPath: stateOwner.path,
    stateLockPath: paths.stateLockPath,
    stateDir: paths.stateDir,
    assertCurrent: assertStateOwnerCurrent,
    assertDatabaseAccess,
    run: (operation) => {
      assertStateOwnerCurrent();
      return resources ? resources.run(operation) : operation();
    },
    releaseInTree,
    release: () =>
      (released ??= (async () => {
        await ownerLease?.release();
        await releaseInTree();
        stateOwner.release();
      })().catch((error: unknown) => {
        released = undefined;
        throw error;
      })),
  };
}
