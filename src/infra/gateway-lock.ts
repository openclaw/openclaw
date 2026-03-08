import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { isPidAlive } from "../shared/pid-alive.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1000;

type LockPayload = {
  pid: number;
  createdAt: string;
  configPath: string;
  startTime?: number;
};

export type GatewayLockHandle = {
  lockPath: string;
  configPath: string;
  release: () => Promise<void>;
};

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
  onTelemetry?: (event: GatewayLockTelemetryEvent) => void;
};

export class GatewayLockError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

export type GatewayLockTelemetryEvent =
  | {
      event: "acquire-skipped";
      reason: "multi-gateway-override" | "test-env";
    }
  | {
      event: "acquire-start";
      lockPath: string;
      configPath: string;
      timeoutMs: number;
      pollIntervalMs: number;
      staleMs: number;
      platform: NodeJS.Platform;
      port?: number;
    }
  | {
      event: "acquire-contention";
      lockPath: string;
      ownerPid?: number;
      ownerStatus: LockOwnerStatus;
      waitedMs: number;
      attempt: number;
    }
  | {
      event: "stale-lock-recovered";
      lockPath: string;
      ownerPid?: number;
      ownerStatus: LockOwnerStatus;
      reason: "owner-dead" | "stale-unknown-owner";
      waitedMs: number;
      attempt: number;
    }
  | {
      event: "acquire-success";
      lockPath: string;
      configPath: string;
      waitedMs: number;
      attempts: number;
      staleRecoveries: number;
    }
  | {
      event: "acquire-timeout";
      lockPath: string;
      ownerPid?: number;
      waitedMs: number;
      timeoutMs: number;
      attempts: number;
    };

function normalizeProcArg(arg: string): string {
  return arg.replaceAll("\\", "/").toLowerCase();
}

function parseProcCmdline(raw: string): string[] {
  return raw
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isGatewayArgv(args: string[]): boolean {
  const normalized = args.map(normalizeProcArg);
  if (!normalized.includes("gateway")) {
    return false;
  }

  const entryCandidates = [
    "dist/index.js",
    "dist/entry.js",
    "openclaw.mjs",
    "scripts/run-node.mjs",
    "src/index.ts",
  ];
  if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) {
    return true;
  }

  const exe = normalized[0] ?? "";
  return exe.endsWith("/openclaw") || exe === "openclaw";
}

function readLinuxCmdline(pid: number): string[] | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return parseProcCmdline(raw);
  } catch {
    return null;
  }
}

function readLinuxStartTime(pid: number): number | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const rest = raw.slice(closeParen + 1).trim();
    const fields = rest.split(/\s+/);
    const startTime = Number.parseInt(fields[19] ?? "", 10);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function checkPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Conservative for liveness checks: timeout usually means no responsive
      // local listener, so treat the lock owner as stale.
      finish(true);
    }, DEFAULT_PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(true);
    });
  });
}

async function resolveGatewayOwnerStatus(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  port: number | undefined,
): Promise<LockOwnerStatus> {
  if (port != null) {
    const portFree = await checkPortFree(port);
    if (portFree) {
      return "dead";
    }
  }

  if (!isPidAlive(pid)) {
    return "dead";
  }
  if (platform !== "linux") {
    return "alive";
  }

  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = readLinuxStartTime(pid);
    if (currentStartTime == null) {
      return "unknown";
    }
    return currentStartTime === payloadStartTime ? "alive" : "dead";
  }

  const args = readLinuxCmdline(pid);
  if (!args) {
    return "unknown";
  }
  return isGatewayArgv(args) ? "alive" : "dead";
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number") {
      return null;
    }
    if (typeof parsed.createdAt !== "string") {
      return null;
    }
    if (typeof parsed.configPath !== "string") {
      return null;
    }
    const startTime = typeof parsed.startTime === "number" ? parsed.startTime : undefined;
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      configPath: parsed.configPath,
      startTime,
    };
  } catch {
    return null;
  }
}

function resolveGatewayLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  const lockPath = path.join(lockDir, `gateway.${hash}.lock`);
  return { lockPath, configPath };
}

function isLockPayloadStale(payload: LockPayload | null, staleMs: number, nowMs: number): boolean {
  const createdAt = payload?.createdAt;
  if (!createdAt) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return nowMs - createdAtMs > staleMs;
}

async function isLockMtimeStale(
  lockPath: string,
  staleMs: number,
  nowMs: number,
): Promise<boolean> {
  try {
    const st = await fs.stat(lockPath);
    return nowMs - st.mtimeMs > staleMs;
  } catch {
    // On Windows or locked filesystems we may be unable to stat the lock file
    // even when another gateway owns it. Prefer waiting over force-removal.
    return false;
  }
}

async function removeLockFile(lockPath: string, reason: string): Promise<void> {
  try {
    await fs.rm(lockPath, { force: true });
  } catch (err) {
    throw new GatewayLockError(
      `failed to remove gateway lock file (${reason}) at ${lockPath}`,
      err,
    );
  }
}

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const emitTelemetry = (event: GatewayLockTelemetryEvent) => {
    try {
      opts.onTelemetry?.(event);
    } catch {
      // Best-effort telemetry only; lock behavior must remain unaffected.
    }
  };
  const env = opts.env ?? process.env;
  const allowInTests = opts.allowInTests === true;
  if (env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1") {
    emitTelemetry({ event: "acquire-skipped", reason: "multi-gateway-override" });
    return null;
  }
  if (!allowInTests && (env.VITEST || env.NODE_ENV === "test")) {
    emitTelemetry({ event: "acquire-skipped", reason: "test-env" });
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const platform = opts.platform ?? process.platform;
  const port = opts.port;
  const { lockPath, configPath } = resolveGatewayLockPath(env);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  emitTelemetry({
    event: "acquire-start",
    lockPath,
    configPath,
    timeoutMs,
    pollIntervalMs,
    staleMs,
    platform,
    port,
  });

  const startedAt = Date.now();
  let lastPayload: LockPayload | null = null;
  let attempts = 0;
  let staleRecoveries = 0;
  let contentionReported = false;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const handle = await fs.open(lockPath, "wx");
      const startTime = platform === "linux" ? readLinuxStartTime(process.pid) : null;
      const payload: LockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
      };
      if (typeof startTime === "number" && Number.isFinite(startTime)) {
        payload.startTime = startTime;
      }
      try {
        await handle.writeFile(JSON.stringify(payload), "utf8");
      } catch (writeErr) {
        await handle.close().catch(() => undefined);
        await removeLockFile(lockPath, "cleanup after write failure").catch(() => undefined);
        throw new GatewayLockError(`failed to write gateway lock payload at ${lockPath}`, writeErr);
      }
      emitTelemetry({
        event: "acquire-success",
        lockPath,
        configPath,
        waitedMs: Date.now() - startedAt,
        attempts,
        staleRecoveries,
      });
      return {
        lockPath,
        configPath,
        release: async () => {
          await handle.close().catch(() => undefined);
          await removeLockFile(lockPath, "release");
        },
      };
    } catch (err) {
      if (err instanceof GatewayLockError) {
        throw err;
      }
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, err);
      }

      lastPayload = await readLockPayload(lockPath);
      const ownerPid = typeof lastPayload?.pid === "number" ? lastPayload.pid : undefined;
      const ownerStatus = ownerPid
        ? await resolveGatewayOwnerStatus(ownerPid, lastPayload, platform, port)
        : "unknown";
      const waitedMs = Date.now() - startedAt;
      if (!contentionReported) {
        emitTelemetry({
          event: "acquire-contention",
          lockPath,
          ownerPid,
          ownerStatus,
          waitedMs,
          attempt: attempts,
        });
        contentionReported = true;
      }
      if (ownerStatus === "dead" && ownerPid) {
        await removeLockFile(lockPath, "stale-owner recovery");
        staleRecoveries += 1;
        emitTelemetry({
          event: "stale-lock-recovered",
          lockPath,
          ownerPid,
          ownerStatus,
          reason: "owner-dead",
          waitedMs,
          attempt: attempts,
        });
        contentionReported = false;
        continue;
      }
      if (ownerStatus !== "alive") {
        const nowMs = Date.now();
        let stale = isLockPayloadStale(lastPayload, staleMs, nowMs);
        if (!stale) {
          stale = await isLockMtimeStale(lockPath, staleMs, nowMs);
        }
        if (stale) {
          await removeLockFile(lockPath, "stale-timestamp recovery");
          staleRecoveries += 1;
          emitTelemetry({
            event: "stale-lock-recovered",
            lockPath,
            ownerPid,
            ownerStatus,
            reason: "stale-unknown-owner",
            waitedMs,
            attempt: attempts,
          });
          contentionReported = false;
          continue;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  emitTelemetry({
    event: "acquire-timeout",
    lockPath,
    ownerPid: typeof lastPayload?.pid === "number" ? lastPayload.pid : undefined,
    waitedMs: Date.now() - startedAt,
    timeoutMs,
    attempts,
  });
  const owner = typeof lastPayload?.pid === "number" ? ` (pid ${lastPayload.pid})` : "";
  throw new GatewayLockError(`gateway already running${owner}; lock timeout after ${timeoutMs}ms`);
}
