import { spawnSync } from "node:child_process";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveLsofCommandSync } from "./ports-lsof.js";

const SPAWN_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
/**
 * After SIGKILL, the kernel may not release the TCP port immediately.
 * Poll until the port is confirmed free (or until the budget expires) before
 * returning control to the caller (typically `triggerOpenClawRestart` →
 * `systemctl restart`). Without this wait the new process races the dying
 * process for the port and systemd enters an EADDRINUSE restart loop.
 */
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;

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
 * Poll the given port using lsof until no listeners are found or the timeout
 * expires. Runs synchronously so callers (e.g. systemctl restart wrappers)
 * block until the port is actually free before handing off to the supervisor.
 */
function waitForPortFreeSync(port: number): void {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pids = findGatewayPidsOnPortSync(port);
      if (pids.length === 0) {
        return;
      }
    } catch {
      // lsof unavailable — bail out rather than spin forever
      return;
    }
    sleepSync(PORT_FREE_POLL_INTERVAL_MS);
  }
  restartLog.warn(
    `port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`,
  );
}

/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Blocks until the port is confirmed free (or the poll budget expires) so
 * the supervisor (systemd / launchctl) does not race a zombie process for
 * the port and enter an EADDRINUSE restart loop.
 *
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
    const killed = terminateStaleProcessesSync(stalePids);
    // Wait for the port to be released before returning — without this, the
    // supervisor fires `systemctl restart` while the kernel still has the
    // socket in TIME_WAIT / FIN_WAIT and the new process hits EADDRINUSE.
    waitForPortFreeSync(port);
    return killed;
  } catch {
    return [];
  }
}

export const __testing = {
  setSleepSyncOverride(fn: ((ms: number) => void) | null) {
    sleepSyncOverride = fn;
  },
};
