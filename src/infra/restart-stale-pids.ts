import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isGatewayArgv } from "./gateway-process-argv.js";
import { resolveLsofCommandSync } from "./ports-lsof.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsListeningPidsResultSync,
  readWindowsProcessArgsResultSync,
  readWindowsProcessArgsSync,
  type WindowsProcessArgsResult,
  type WindowsListeningPidsResult,
} from "./windows-port-pids.js";

const SPAWN_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
/**
 * After SIGKILL, the kernel may not release the TCP port immediately.
 * Poll until the port is confirmed free (or until the budget expires) before
 * returning control to the caller (typically `triggerOpenClawRestart` →
 * `systemctl restart`). Without this wait the new process races the dying
 * process for the port and systemd enters an EADDRINUSE restart loop.
 *
 * POLL_SPAWN_TIMEOUT_MS is intentionally much shorter than SPAWN_TIMEOUT_MS
 * so that a single slow or hung lsof invocation does not consume the entire
 * polling budget. At 400 ms per call, up to five independent lsof attempts
 * fit within PORT_FREE_TIMEOUT_MS = 2000 ms, each with a definitive outcome.
 */
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;
const POLL_SPAWN_TIMEOUT_MS = 400;

const restartLog = createSubsystemLogger("restart");
let sleepSyncOverride: ((ms: number) => void) | null = null;
let dateNowOverride: (() => number) | null = null;

function getTimeMs(): number {
  return dateNowOverride ? dateNowOverride() : Date.now();
}

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
 * Parse openclaw gateway PIDs from lsof -Fpc stdout.
 * Pure function — no I/O. Excludes the current process.
 */
function parsePidsFromLsofOutput(stdout: string): number[] {
  const pids: number[] = [];
  let currentPid: number | undefined;
  let currentCmd: string | undefined;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("p")) {
      if (
        currentPid != null &&
        currentCmd &&
        normalizeLowercaseStringOrEmpty(currentCmd).includes("openclaw")
      ) {
        pids.push(currentPid);
      }
      const parsed = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      currentCmd = undefined;
    } else if (line.startsWith("c")) {
      currentCmd = line.slice(1);
    }
  }
  if (
    currentPid != null &&
    currentCmd &&
    normalizeLowercaseStringOrEmpty(currentCmd).includes("openclaw")
  ) {
    pids.push(currentPid);
  }
  // Deduplicate: dual-stack listeners (IPv4 + IPv6) cause lsof to emit the
  // same PID twice. Return each PID at most once to avoid double-killing.
  return [...new Set(pids)].filter((pid) => pid !== process.pid);
}

/**
 * Windows: find listening PIDs on the port, then verify each is an openclaw
 * gateway process via command-line inspection. Excludes the current process.
 */
function filterVerifiedWindowsGatewayPids(rawPids: number[]): number[] {
  return Array.from(new Set(rawPids))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => {
      const args = readWindowsProcessArgsSync(pid);
      return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

function filterVerifiedWindowsGatewayPidsResult(
  rawPids: number[],
  processArgsResult: (pid: number) => WindowsProcessArgsResult,
): WindowsListeningPidsResult {
  const verified: number[] = [];
  for (const pid of Array.from(new Set(rawPids))) {
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    const argsResult = processArgsResult(pid);
    if (!argsResult.ok) {
      return { ok: false, permanent: argsResult.permanent };
    }
    if (argsResult.args != null && isGatewayArgv(argsResult.args, { allowGatewayBinary: true })) {
      verified.push(pid);
    }
  }
  return { ok: true, pids: verified };
}

function findVerifiedWindowsGatewayPidsOnPortSync(port: number): number[] {
  return filterVerifiedWindowsGatewayPids(readWindowsListeningPidsOnPortSync(port));
}

function findVerifiedWindowsGatewayPidsOnPortResultSync(port: number): WindowsListeningPidsResult {
  const result = readWindowsListeningPidsResultSync(port);
  if (!result.ok) {
    return result;
  }
  return filterVerifiedWindowsGatewayPidsResult(result.pids, (pid) =>
    readWindowsProcessArgsResultSync(pid),
  );
}

/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export function findGatewayPidsOnPortSync(
  port: number,
  spawnTimeoutMs = SPAWN_TIMEOUT_MS,
): number[] {
  if (process.platform === "win32") {
    // Use the shared Windows port inspection (PowerShell / netstat) with
    // command-line verification to find only openclaw gateway processes.
    return findVerifiedWindowsGatewayPidsOnPortSync(port);
  }
  const lsof = resolveLsofCommandSync();
  const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    timeout: spawnTimeoutMs,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    const detail =
      code && code.trim().length > 0
        ? code
        : res.error instanceof Error
          ? res.error.message
          : "unknown error";
    restartLog.warn(`lsof failed during initial stale-pid scan for port ${port}: ${detail}`);
    return [];
  }
  if (res.status === 1) {
    return [];
  }
  if (res.status !== 0) {
    restartLog.warn(
      `lsof exited with status ${res.status} during initial stale-pid scan for port ${port}; skipping stale pid check`,
    );
    return [];
  }
  return parsePidsFromLsofOutput(res.stdout);
}

/**
 * Attempt a single lsof poll for the given port.
 *
 * Returns a discriminated union with four possible states:
 *
 *   { free: true }                      — port confirmed free
 *   { free: false }                     — port confirmed busy
 *   { free: null; permanent: false }    — transient error, keep retrying
 *   { free: null; permanent: true }     — lsof unavailable (ENOENT / EACCES),
 *                                         no point retrying
 *
 * Separating transient from permanent errors is critical so that:
 *  1. A slow/timed-out lsof call (transient) does not abort the polling loop —
 *     the caller retries until the wall-clock budget expires.
 *  2. Non-zero lsof exits from runtime/permission failures (status > 1) are
 *     not misclassified as "port free" — they are inconclusive and retried.
 *  3. A missing lsof binary (permanent) short-circuits cleanly rather than
 *     spinning the full budget pointlessly.
 */
type PollResult = { free: true } | { free: false } | { free: null; permanent: boolean };

function pollPortOnce(port: number): PollResult {
  if (process.platform === "win32") {
    return pollPortOnceWindows(port);
  }
  try {
    const lsof = resolveLsofCommandSync();
    const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: POLL_SPAWN_TIMEOUT_MS,
    });
    if (res.error) {
      // Spawn-level failure. ENOENT / EACCES means lsof is permanently
      // unavailable on this system; other errors (e.g. timeout) are transient.
      const code = (res.error as NodeJS.ErrnoException).code;
      const permanent = code === "ENOENT" || code === "EACCES" || code === "EPERM";
      return { free: null, permanent };
    }
    if (res.status === 1) {
      // lsof canonical "no matching processes" exit — port is genuinely free.
      // Guard: on Linux containers with restricted /proc (AppArmor, seccomp,
      // user namespaces), lsof can exit 1 AND still emit some output for the
      // processes it could read. Parse stdout when non-empty to avoid false-free.
      if (res.stdout) {
        const pids = parsePidsFromLsofOutput(res.stdout);
        return pids.length === 0 ? { free: true } : { free: false };
      }
      return { free: true };
    }
    if (res.status !== 0) {
      // status > 1: runtime/permission/flag error. Cannot confirm port state —
      // treat as a transient failure and keep polling rather than falsely
      // reporting the port as free (which would recreate the EADDRINUSE race).
      return { free: null, permanent: false };
    }
    // status === 0: lsof found listeners. Parse pids from the stdout we
    // already hold — no second lsof spawn, no new failure surface.
    const pids = parsePidsFromLsofOutput(res.stdout);
    return pids.length === 0 ? { free: true } : { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

/**
 * Windows-specific port poll.
 * Uses a short timeout (POLL_SPAWN_TIMEOUT_MS) so a single slow PowerShell
 * invocation cannot exceed the waitForPortFreeSync wall-clock budget.
 * Only checks whether any process is listening — no gateway verification
 * needed because we already killed the stale gateway in the prior step.
 */
function pollPortOnceWindows(port: number): PollResult {
  try {
    const result = readWindowsListeningPidsResultSync(port, POLL_SPAWN_TIMEOUT_MS);
    if (!result.ok) {
      return { free: null, permanent: result.permanent };
    }
    return result.pids.length === 0 ? { free: true } : { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

/**
 * Synchronously terminate stale gateway processes.
 * Callers must pass a non-empty pids array.
 *
 * On Unix: sends SIGTERM, waits briefly, then SIGKILL for survivors.
 * On Windows: uses taskkill (graceful first, then /F for force-kill).
 */
function terminateStaleProcessesSync(pids: number[]): number[] {
  if (process.platform === "win32") {
    return terminateStaleProcessesWindows(pids);
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
 * Windows-specific process termination using taskkill.
 * Sends a graceful taskkill first (/T for tree), waits, then escalates to /F.
 */
function terminateStaleProcessesWindows(pids: number[]): number[] {
  const taskkillPath = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  const killed: number[] = [];
  for (const pid of pids) {
    const graceful = spawnSync(taskkillPath, ["/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    const gracefulFailed = graceful.error != null || (graceful.status ?? 0) !== 0;
    if (!gracefulFailed && !isProcessAlive(pid)) {
      killed.push(pid);
      continue;
    }
    sleepSync(STALE_SIGTERM_WAIT_MS);
    if (!isProcessAlive(pid)) {
      killed.push(pid);
      continue;
    }
    const forced = spawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (forced.error != null || (forced.status ?? 0) !== 0) {
      continue;
    }
    sleepSync(STALE_SIGKILL_WAIT_MS);
    if (!isProcessAlive(pid)) {
      killed.push(pid);
    }
  }
  return killed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Poll the given port until it is confirmed free, lsof is confirmed unavailable,
 * or the wall-clock budget expires.
 *
 * Each poll invocation uses POLL_SPAWN_TIMEOUT_MS (400 ms), which is
 * significantly shorter than PORT_FREE_TIMEOUT_MS (2000 ms). This ensures
 * that a single slow or hung lsof call cannot consume the entire polling
 * budget and cause the function to exit prematurely with an inconclusive
 * result. Up to five independent lsof attempts fit within the budget.
 *
 * Exit conditions:
 *   - `pollPortOnce` returns `{ free: true }`                    → port confirmed free
 *   - `pollPortOnce` returns `{ free: null, permanent: true }`   → lsof unavailable, bail
 *   - `pollPortOnce` returns `{ free: false }`                   → port busy, sleep + retry
 *   - `pollPortOnce` returns `{ free: null, permanent: false }`  → transient error, sleep + retry
 *   - Wall-clock deadline exceeded                               → log warning, proceed anyway
 */
function waitForPortFreeSync(port: number): void {
  const deadline = getTimeMs() + PORT_FREE_TIMEOUT_MS;
  while (getTimeMs() < deadline) {
    const result = pollPortOnce(port);
    if (result.free === true) {
      return;
    }
    if (result.free === null && result.permanent) {
      // lsof is permanently unavailable (ENOENT / EACCES) — bail immediately,
      // no point spinning the remaining budget.
      return;
    }
    // result.free === false: port still bound.
    // result.free === null && !permanent: transient lsof error — keep polling.
    sleepSync(PORT_FREE_POLL_INTERVAL_MS);
  }
  restartLog.warn(`port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`);
}

/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Blocks until the port is confirmed free (or the poll budget expires) so
 * the supervisor (systemd / launchctl) does not race a zombie process for
 * the port and enter an EADDRINUSE restart loop.
 *
 * Called before service restart commands to prevent port conflicts.
 */
export function cleanStaleGatewayProcessesSync(portOverride?: number): number[] {
  try {
    const port =
      typeof portOverride === "number" && Number.isFinite(portOverride) && portOverride > 0
        ? Math.floor(portOverride)
        : resolveGatewayPort(undefined, process.env);
    const stalePids =
      process.platform === "win32"
        ? (() => {
            const result = findVerifiedWindowsGatewayPidsOnPortResultSync(port);
            if (result.ok) {
              return result.pids;
            }
            waitForPortFreeSync(port);
            return [];
          })()
        : findGatewayPidsOnPortSync(port);
    if (stalePids.length === 0) {
      return [];
    }
    restartLog.warn(
      `killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`,
    );
    const killed = terminateStaleProcessesSync(stalePids);
    // Wait for the port to be released before returning — called unconditionally
    // even when `killed` is empty (all pids were already dead before SIGTERM).
    // A process can exit before our signal arrives yet still leave its socket
    // in TIME_WAIT / FIN_WAIT; polling is the only reliable way to confirm the
    // kernel has fully released the port before systemd fires the new process.
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
  setDateNowOverride(fn: (() => number) | null) {
    dateNowOverride = fn;
  },
  /** Invoke sleepSync directly (bypasses the override) for unit-testing the real Atomics path. */
  callSleepSyncRaw: sleepSync,
};
