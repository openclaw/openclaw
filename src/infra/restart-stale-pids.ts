import { spawnSync } from "node:child_process";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveLsofCommandSync } from "./ports-lsof.js";

const SPAWN_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 300;
const STALE_SIGKILL_WAIT_MS = 200;

const restartLog = createSubsystemLogger("restart");
let sleepSyncOverride: ((ms: number) => void) | null = null;

function sleepSync(ms: number): void {
  const timeoutMs = Math.max(0, Math.floor(ms));
  if (timeoutMs <= 0) {
    return;
  }
  if (sleepSyncOverride) {
    sleepSyncOverride(timeoutMs);
    return;
  }
  try {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(lock, 0, 0, timeoutMs);
  } catch {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Best-effort fallback when Atomics.wait is unavailable.
    }
  }
}

/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export function findGatewayPidsOnPortSync(port: number): number[] {
  if (process.platform === "win32") {
    return [];
  }
  const lsof = resolveLsofCommandSync();
  const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) {
    return [];
  }
  const pids: number[] = [];
  let currentPid: number | undefined;
  let currentCmd: string | undefined;
  for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("p")) {
      if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaw")) {
        pids.push(currentPid);
      }
      const parsed = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      currentCmd = undefined;
    } else if (line.startsWith("c")) {
      currentCmd = line.slice(1);
    }
  }
  if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaw")) {
    pids.push(currentPid);
  }
  return pids.filter((pid) => pid !== process.pid);
}

/**
 * Synchronously terminate stale gateway processes.
 * Sends SIGTERM, waits briefly, then SIGKILL for survivors.
 */
function terminateStaleProcessesSync(pids: number[]): number[] {
  if (pids.length === 0) {
    return [];
  }
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // ESRCH — already gone
    }
  }
  if (killed.length === 0) {
    return killed;
  }
  sleepSync(STALE_SIGTERM_WAIT_MS);
  for (const pid of killed) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  sleepSync(STALE_SIGKILL_WAIT_MS);
  return killed;
}

/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Called before service restart commands to prevent port conflicts.
 */
export function cleanStaleGatewayProcessesSync(): number[] {
  try {
    const port = resolveGatewayPort(undefined, process.env);
    const stalePids = findGatewayPidsOnPortSync(port);
    if (stalePids.length === 0) {
      return [];
    }
    restartLog.warn(
      `killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`,
    );
    return terminateStaleProcessesSync(stalePids);
  } catch {
    return [];
  }
}

export const __testing = {
  setSleepSyncOverride(fn: ((ms: number) => void) | null) {
    sleepSyncOverride = fn;
  },
};
