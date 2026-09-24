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
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { hasErrnoCode } from "./errno.js";
import { createFileLockManager } from "./file-lock-manager.js";
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
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireGatewayMaintenanceCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "./state-database-coordinator.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;
const GATEWAY_LOCKS = createFileLockManager("openclaw.gateway-lock");
export const GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS = 5 * 60_000;
const log = createSubsystemLogger("gateway");

type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  stateDir: string;
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
    error instanceof GatewayLockError &&
    error.cause instanceof StateDatabaseCoordinatorContentionError &&
    error.cause.family === "gateway-lifecycle"
  );
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

const CMDLINE_EXEC_TIMEOUT_MS = 1000;

export async function resolveGatewayOwnerStatus(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  readCmdline?: (pid: number) => string[] | null,
  readStartTime?: (pid: number) => number | null,
  opts: { trustUnknownCmdlineOwner?: boolean; deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<LockOwnerStatus> {
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

async function shouldReclaimGatewayLock(params: {
  lockPath: string;
  payload: LockPayload | null;
  staleMs: number;
  now: () => number;
  platform: NodeJS.Platform;
  readProcessCmdline?: (pid: number) => string[] | null;
  readProcessStartTime?: (pid: number) => number | null;
}): Promise<boolean> {
  const ownerPid = params.payload?.pid;
  const ownerStatus = ownerPid
    ? await resolveGatewayOwnerStatus(
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
    const stat = await fs.stat(params.lockPath);
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
  const { configLockPath, stateLockPath } = resolveGatewayLockPaths(env, opts.lockDir);
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

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const env = opts.env ?? process.env;
  const allowInTests = opts.allowInTests === true;
  if (!allowInTests && (env.VITEST || env.NODE_ENV === "test")) {
    return null;
  }
  const role = opts.role ?? "gateway";
  const ownerId = randomUUID();
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
  let waited = false;
  let stateLifecycle: ReturnType<typeof acquireGatewayLifecycleCoordinator>;
  let resources: ReturnType<typeof createOpenClawDatabaseMaintenanceScope> | undefined;
  try {
    stateLifecycle = await acquireWithWait({
      deadlineMs,
      pollIntervalMs: resolvePositiveTimerTimeoutMs(opts.pollIntervalMs, 250),
      maxPollIntervalMs: 2000,
      now,
      sleep: opts.sleep,
      acquire: () => {
        const options = { databasePath, busyTimeoutMs: 0 };
        if (role === "sqlite-maintenance") {
          const owner = acquireGatewayMaintenanceCoordinator(options);
          resources = createOpenClawDatabaseMaintenanceScope(owner.createSchemaFenceDelegate);
          return owner;
        }
        return acquireGatewayLifecycleCoordinator(options);
      },
      shouldRetry: (error) => {
        if (
          !(error instanceof StateDatabaseCoordinatorContentionError) ||
          error.family !== "gateway-lifecycle"
        ) {
          return false;
        }
        if (!waited && deadlineMs > startedAt && role === "gateway") {
          log.warn(
            `waiting for gateway-lifecycle ownership held by another OpenClaw process, up to ${Math.ceil((deadlineMs - startedAt) / 1000)} s`,
          );
        }
        waited = true;
        return true;
      },
    });
  } catch (error) {
    const waitHint =
      waited && role === "gateway"
        ? `; waited ${Math.round(now() - startedAt)}ms for gateway-lifecycle ownership`
        : "";
    throw new GatewayLockError(`failed to acquire gateway state ownership${waitHint}`, error);
  }
  if (waited && role === "gateway") {
    log.info(
      `gateway-lifecycle ownership acquired after ${((now() - startedAt) / 1000).toFixed(1)} s`,
    );
  }
  let ownerLease: GatewayOwnerLease | undefined;
  let stateLock: Awaited<ReturnType<typeof acquireLockFile>>;
  try {
    if (role === "gateway" && opts.listenerMode && opts.port) {
      ownerLease = acquireGatewayOwnerLease({
        env,
        port: opts.port,
        mode: opts.listenerMode,
        supervisor: opts.supervisor ?? null,
        owner: ownerId,
      });
      await ownerLease.ready;
    }
    stateLock = await acquireLockFile({
      ...opts,
      configPath: paths.configPath,
      env,
      lockPath: paths.stateLockPath,
      role,
      stateDir: paths.stateDir,
      ownerId,
    });
  } catch (error) {
    await ownerLease?.release();
    stateLifecycle.release();
    throw error;
  }
  if (role === "gateway" && env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1") {
    let inTreeReleased = false;
    const releaseInTree = async () => {
      if (inTreeReleased) {
        return;
      }
      inTreeReleased = true;
      await stateLock.release();
    };
    return {
      ...stateLock,
      run: (operation) => operation(),
      stateDir: paths.stateDir,
      stateLockPath: stateLock.lockPath,
      releaseInTree,
      release: async () => {
        // Join the writer and remove its identity before relinquishing physical custody.
        await ownerLease?.release();
        let releaseError: unknown;
        await releaseInTree().catch((error: unknown) => {
          releaseError = error;
        });
        try {
          stateLifecycle.release();
        } catch (error) {
          releaseError ??= error;
        }
        if (releaseError) {
          throw new GatewayLockError("failed to release gateway state ownership", releaseError);
        }
      },
    };
  }

  try {
    const configLock = await acquireLockFile({
      ...opts,
      configPath: paths.configPath,
      env,
      lockPath: paths.configLockPath,
      role,
      stateDir: paths.stateDir,
      ownerId,
    });
    if (role === "sqlite-maintenance") {
      let inTreeReleaseAttempt: Promise<void> | undefined;
      const releaseInTree = () => {
        inTreeReleaseAttempt ??= (async () => {
          await resources?.close();
          await configLock.release();
          await stateLock.release();
        })().catch((error: unknown) => {
          // Retry only this handle's unfinished cleanup while lifecycle custody
          // remains held. Successful drainage must not touch later resources.
          inTreeReleaseAttempt = undefined;
          throw error;
        });
        return inTreeReleaseAttempt;
      };
      return {
        ...configLock,
        run: (operation) => resources!.run(operation),
        stateDir: paths.stateDir,
        stateLockPath: stateLock.lockPath,
        releaseInTree,
        release: async () => {
          await releaseInTree();
          stateLifecycle.release();
        },
      };
    }
    let inTreeReleased = false;
    const releaseInTree = async () => {
      if (inTreeReleased) {
        return;
      }
      inTreeReleased = true;
      let releaseError: Error | undefined;
      try {
        await configLock.release();
      } catch (error) {
        releaseError =
          error instanceof Error
            ? error
            : new GatewayLockError("failed to release config lock", error);
      }
      try {
        await stateLock.release();
      } catch (error) {
        releaseError ??=
          error instanceof Error
            ? error
            : new GatewayLockError("failed to release state lock", error);
      }
      if (releaseError) {
        throw releaseError;
      }
    };
    return {
      ...configLock,
      run: (operation) => operation(),
      stateDir: paths.stateDir,
      stateLockPath: stateLock.lockPath,
      releaseInTree,
      release: async () => {
        await ownerLease?.release();
        let releaseError: Error | undefined;
        try {
          await releaseInTree();
        } catch (error) {
          releaseError =
            error instanceof Error
              ? error
              : new GatewayLockError("failed to release in-tree gateway locks", error);
        }
        try {
          stateLifecycle.release();
        } catch (error) {
          releaseError ??=
            error instanceof Error
              ? error
              : new GatewayLockError("failed to release state lifecycle", error);
        }
        if (releaseError) {
          throw releaseError;
        }
      },
    };
  } catch (error) {
    await stateLock.release().catch(() => undefined);
    await ownerLease?.release();
    try {
      stateLifecycle.release();
    } catch {
      // Preserve the original lock acquisition failure.
    }
    throw error;
  }
}

async function acquireLockFile(
  opts: GatewayLockOptions & {
    configPath: string;
    lockPath: string;
    role: GatewayLockRole;
    stateDir: string;
    ownerId: string;
  },
): Promise<Omit<GatewayLockHandle, "releaseInTree" | "stateDir" | "stateLockPath" | "run">> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 0);
  const pollIntervalMs = resolvePositiveTimerTimeoutMs(
    opts.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const staleMs = resolveTimerTimeoutMs(opts.staleMs, DEFAULT_STALE_MS, 0);
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    (async (ms: number) =>
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const { configPath, lockPath, stateDir } = opts;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = now();
  let lastPayload: LockPayload | null = null;
  const buildPayload = (): LockPayload => {
    const startTime = (
      opts.readProcessStartTime ??
      ((pid) => readGatewayLockProcessStartTime(pid, platform, CMDLINE_EXEC_TIMEOUT_MS))
    )(process.pid);
    return {
      pid: process.pid,
      ownerId: opts.ownerId,
      ...(opts.role === "gateway" ? { cronOwnerProjection: "dynamic-default-v1" as const } : {}),
      createdAt: resolveTimestampMsToIsoString(now()),
      configPath,
      stateDir,
      ...(typeof opts.port === "number" &&
      Number.isInteger(opts.port) &&
      opts.port > 0 &&
      opts.port <= 65_535
        ? { port: opts.port }
        : {}),
      ...(opts.role !== "gateway" ? { role: opts.role } : {}),
      ...(typeof startTime === "number" && Number.isFinite(startTime) ? { startTime } : {}),
    };
  };
  const shouldReclaim = (payload: LockPayload | null) =>
    shouldReclaimGatewayLock({
      lockPath,
      payload,
      staleMs,
      now,
      platform,
      readProcessCmdline: opts.readProcessCmdline,
      readProcessStartTime: opts.readProcessStartTime,
    });

  while (now() - startedAt < timeoutMs) {
    let coordinator: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator>;
    try {
      coordinator = tryAcquireExclusiveSqliteCoordinator(`${lockPath}.sqlite`);
    } catch (error) {
      throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, error);
    }
    if (!coordinator) {
      lastPayload = await readLockPayload(lockPath);
    } else {
      try {
        const lock = await GATEWAY_LOCKS.acquire(lockPath, {
          lockPath,
          staleMs,
          timeoutMs: 0,
          retry: { retries: 0 },
          staleRecovery: "remove-if-unchanged",
          payload: buildPayload,
          parsePayload: parseGatewayLockPayload,
          shouldReclaim: ({ payload }) => shouldReclaim(payload as LockPayload | null),
          shouldRemoveStaleLock: ({ payload }) => shouldReclaim(payload as LockPayload | null),
        });
        return {
          lockPath,
          release: async () => {
            let releaseError: unknown;
            try {
              coordinator.release();
            } catch (error) {
              releaseError = error;
            }
            await lock.release().catch((error: unknown) => {
              releaseError ??= error;
            });
            if (releaseError) {
              throw new GatewayLockError(
                `failed to release gateway lock at ${lockPath}`,
                releaseError,
              );
            }
          },
        };
      } catch (error) {
        coordinator.release();
        const code = (error as { code?: unknown }).code;
        if (code !== "file_lock_timeout" && code !== "file_lock_stale") {
          throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, error);
        }
        lastPayload = await readLockPayload(lockPath);
      }
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const ownerPid = lastPayload?.pid ? ` (pid ${lastPayload.pid})` : "";
  const owner =
    lastPayload?.role === "agent-embedded"
      ? `another embedded OpenClaw state writer is active${ownerPid}`
      : lastPayload?.role && lastPayload.role !== "gateway"
        ? `state directory is locked by ${lastPayload.role}${ownerPid}`
        : `gateway already running${ownerPid}`;
  throw new GatewayLockError(`${owner}; lock timeout after ${timeoutMs}ms`);
}
