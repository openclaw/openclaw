// Finds and cleans stale gateway process ids.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readUnixProcessGroupMembers, signalProcessTree } from "../process/kill-tree.js";
import {
  collectProcessAncestorPids,
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
  MAX_ANCESTOR_WALK_DEPTH,
} from "../shared/pid-alive.js";
import { sleep } from "../utils/sleep.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import { resolveLsofCommandSync } from "./ports-lsof.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { spawnPsSync } from "./spawn-ps.js";
import { getWindowsInstallRoots } from "./windows-install-roots.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsListeningPidsResultSync,
  readWindowsProcessArgsResultSync,
  readWindowsProcessArgsSync,
  type WindowsProcessArgsResult,
  type WindowsListeningPidsResult,
} from "./windows-port-pids.js";
import { readWindowsProcessAncestorsSync } from "./windows-process-start.js";

// macOS lsof needs seconds on hosts with many mounted volumes; keep that
// allowance separate so process and ancestor probes retain their tighter bound.
const INITIAL_LSOF_TIMEOUT_MS = 5000;
const PROCESS_INSPECTION_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
// Allow the kernel to release the port after SIGKILL before the supervisor restarts.
// Each probe has its own shorter bound so one slow lsof cannot consume the whole budget.
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;
const POLL_SPAWN_TIMEOUT_MS = 400;

const restartLog = createSubsystemLogger("restart");

/** Terminate externally discovered stale gateway processes and allow cleanup to settle. */
export async function terminateStaleGatewayPids(
  pids: number[],
  options: { env?: NodeJS.ProcessEnv; assertCurrent?: () => void } = {},
): Promise<number[]> {
  const ownerContext = { env: options.env };
  if (readGatewayOwnerLease(ownerContext)) {
    return [];
  }
  const targets = Array.from(
    new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
  ).map((pid) => ({ pid, startedAt: getFileLockProcessStartTime(pid, options.env) }));
  const canSignal = (target: (typeof targets)[number]) => {
    if (
      target.startedAt === null ||
      isPidDefinitelyDead(target.pid) ||
      getFileLockProcessStartTime(target.pid, options.env) !== target.startedAt ||
      readGatewayOwnerLease(ownerContext)
    ) {
      return false;
    }
    options.assertCurrent?.();
    return true;
  };
  const signal = (pid: number, value: "SIGTERM" | "SIGKILL", detached?: boolean) =>
    new Promise<void>((resolve) => {
      signalProcessTree(pid, value, { detached, onComplete: resolve });
    });
  const signaled: Array<{ target: (typeof targets)[number]; members: typeof targets }> = [];
  for (const target of targets) {
    const members = readUnixProcessGroupMembers(target.pid).map((pid) =>
      pid === target.pid
        ? target
        : { pid, startedAt: getFileLockProcessStartTime(pid, options.env) },
    );
    // A member may have exited and recycled while its start identity was read.
    const currentMembers = new Set(readUnixProcessGroupMembers(target.pid));
    if (canSignal(target)) {
      await signal(target.pid, "SIGTERM");
      signaled.push({ target, members: members.filter(({ pid }) => currentMembers.has(pid)) });
    }
  }
  if (signaled.length > 0) {
    await sleep(300);
    for (const { members } of signaled) {
      // Keep exact member identities after leader exit; never expand a recycled group.
      for (const member of members) {
        if (canSignal(member)) {
          await signal(member.pid, "SIGKILL", false);
        }
      }
    }
    await sleep(200);
  }
  return signaled.map(({ target }) => target.pid);
}

function sleepSync(ms: number): void {
  const timeoutMs = Math.max(0, Math.floor(ms));
  if (timeoutMs <= 0) {
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

/** An unreadable /proc hop truncates the best-effort ancestor walk. */
function readParentPidFromProc(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s*(\d+)/m);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    // Restricted /proc can hide transitive ancestors; process.ppid still protects the direct parent.
    return null;
  }
}

function readParentPidFromPs(pid: number, spawnTimeoutMs: number): number | null {
  try {
    const res = spawnPsSync(["-o", "ppid=", "-p", String(pid)], spawnTimeoutMs);
    if (res.error || res.status !== 0 || !res.stdout.trim()) {
      return null;
    }
    return parseStrictPositiveInteger(res.stdout.trim()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Protect the caller and its ancestors from cleanup that would cascade-kill the caller.
 * Include PID 1 for container Gateways. process.ppid is always available; transitive
 * ancestry is best effort through /proc, ps, or one Windows process snapshot.
 */
export function inspectSelfAndAncestorPidsSync(
  spawnTimeoutMs = PROCESS_INSPECTION_TIMEOUT_MS,
  options: { requireVerifiedParent?: boolean } = {},
): { pids: Set<number>; complete: boolean } {
  const pids = new Set<number>([process.pid]);
  const immediateParent = process.ppid;
  if (!Number.isFinite(immediateParent) || immediateParent <= 0) {
    return { pids, complete: process.platform !== "win32" && pids.has(1) };
  }
  // Windows retains an inherited PID after parent exit. Cleanup can exclude it
  // conservatively, but callers granting authority need the creation-ordered snapshot.
  if (process.platform !== "win32" || !options.requireVerifiedParent) {
    pids.add(immediateParent);
  }
  if (process.platform === "win32") {
    const ancestry = readWindowsProcessAncestorsSync(
      process.pid,
      MAX_ANCESTOR_WALK_DEPTH,
      spawnTimeoutMs,
    );
    for (const pid of ancestry.pids) {
      pids.add(pid);
    }
    return { pids, complete: ancestry.complete };
  }
  const readTransitiveParent =
    process.platform === "linux"
      ? readParentPidFromProc
      : process.platform === "darwin"
        ? (pid: number) => readParentPidFromPs(pid, spawnTimeoutMs)
        : null;
  if (!readTransitiveParent) {
    return { pids, complete: pids.has(1) };
  }
  const ancestors = collectProcessAncestorPids(immediateParent, readTransitiveParent);
  return { pids: ancestors, complete: ancestors.has(1) };
}

/** Cleanup protects every observed ancestor, even when the remaining chain is unknown. */
export function getSelfAndAncestorPidsSync(
  spawnTimeoutMs = PROCESS_INSPECTION_TIMEOUT_MS,
  options: { requireVerifiedParent?: boolean } = {},
): Set<number> {
  return inspectSelfAndAncestorPidsSync(spawnTimeoutMs, options).pids;
}

function getExcludedGatewayPidsSync(spawnTimeoutMs: number, protectedPid?: number): Set<number> {
  const excluded = getSelfAndAncestorPidsSync(spawnTimeoutMs);
  if (typeof protectedPid === "number" && Number.isSafeInteger(protectedPid) && protectedPid > 0) {
    // A reparented service can become a sibling and disappear from the ancestor walk.
    excluded.add(protectedPid);
  }
  return excluded;
}

function parsePsCommandLine(raw: string): string[] {
  const args: string[] = [];
  for (const match of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) {
      args.push(value);
    }
  }
  return args;
}

function readUnixProcessArgsSync(pid: number, spawnTimeoutMs: number): string[] | null {
  const args = readGatewayLockProcessCmdline(pid, process.platform, spawnTimeoutMs);
  if (args?.length || process.platform === "darwin") {
    return args;
  }
  const res = spawnPsSync(["-ww", "-p", String(pid), "-o", "command="], spawnTimeoutMs);
  if (res.error || res.status !== 0 || !res.stdout.trim()) {
    return null;
  }
  return parsePsCommandLine(res.stdout.trim());
}

function verifyGatewayPidByArgvSync(pid: number, spawnTimeoutMs: number): boolean {
  const args = readUnixProcessArgsSync(pid, spawnTimeoutMs);
  return (
    args != null && classifyOpenClawArgv(args, { command: "gateway", pid }).kind === "openclaw"
  );
}

function parsePidsFromLsofOutput(
  stdout: string,
  spawnTimeoutMs: number,
  protectedPid?: number,
): number[] {
  // Deduplicate: dual-stack listeners (IPv4 + IPv6) cause lsof to emit the
  // same PID twice. Return each PID at most once to avoid double-killing.
  // Exclude self and ancestors — terminating any ancestor cascade-kills the
  // caller via the supervisor, recreating the #68451 restart loop.
  const excluded = getExcludedGatewayPidsSync(spawnTimeoutMs, protectedPid);
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const pid = line.startsWith("p") ? parseStrictPositiveInteger(line.slice(1)) : undefined;
    if (!pid || excluded.has(pid)) {
      continue;
    }
    if (verifyGatewayPidByArgvSync(pid, spawnTimeoutMs)) {
      pids.push(pid);
    }
  }
  return uniqueValues(pids);
}

// Recorded owners are never stale targets; unverifiable argv must stay explicit.
function verifyWindowsGatewayArgv(pid: number, args: string[] | null): boolean {
  if (!args) {
    return false;
  }
  const identity = classifyOpenClawArgv(args, { command: "gateway", pid });
  if (identity.kind === "unclassified") {
    restartLog.warn(`Could not classify PID ${pid}: ${identity.reason}; leaving listener running.`);
  }
  return identity.kind === "openclaw";
}

function filterVerifiedWindowsGatewayPids(rawPids: number[], protectedPid?: number): number[] {
  const excluded = getExcludedGatewayPidsSync(PROCESS_INSPECTION_TIMEOUT_MS, protectedPid);
  return uniqueValues(rawPids)
    .filter((pid) => Number.isFinite(pid) && pid > 0 && !excluded.has(pid))
    .filter((pid) => verifyWindowsGatewayArgv(pid, readWindowsProcessArgsSync(pid)));
}

function filterVerifiedWindowsGatewayPidsResult(
  rawPids: number[],
  processArgsResult: (pid: number) => WindowsProcessArgsResult,
  protectedPid?: number,
): WindowsListeningPidsResult {
  const excluded = getExcludedGatewayPidsSync(PROCESS_INSPECTION_TIMEOUT_MS, protectedPid);
  const verified: number[] = [];
  for (const pid of uniqueValues(rawPids)) {
    if (!Number.isFinite(pid) || pid <= 0 || excluded.has(pid)) {
      continue;
    }
    const argsResult = processArgsResult(pid);
    if (!argsResult.ok) {
      return { ok: false, permanent: argsResult.permanent };
    }
    if (verifyWindowsGatewayArgv(pid, argsResult.args)) {
      verified.push(pid);
    }
  }
  return { ok: true, pids: verified };
}

type CleanStaleGatewayProcessesOptions = {
  env?: NodeJS.ProcessEnv;
  /** Reassert effect authority after blocking probes and before every signal. */
  assertCurrent?: () => void;
  protectedPid?: number;
  // Resolve only after listener enumeration so supervisor respawns captured by
  // that snapshot cannot be mistaken for stale processes. Throw to skip cleanup.
  resolveProtectedPid?: () => number | undefined;
};

function resolveProtectedPidAfterEnumeration(
  options: CleanStaleGatewayProcessesOptions | undefined,
): number | undefined {
  return options?.resolveProtectedPid ? options.resolveProtectedPid() : options?.protectedPid;
}

function findVerifiedWindowsGatewayPidsOnPortSync(
  port: number,
  options?: CleanStaleGatewayProcessesOptions,
): number[] {
  const rawPids = readWindowsListeningPidsOnPortSync(port);
  return filterVerifiedWindowsGatewayPids(rawPids, resolveProtectedPidAfterEnumeration(options));
}

function findVerifiedWindowsGatewayPidsOnPortResultSync(
  port: number,
  options?: CleanStaleGatewayProcessesOptions,
): WindowsListeningPidsResult {
  const result = readWindowsListeningPidsResultSync(port);
  if (!result.ok) {
    return result;
  }
  return filterVerifiedWindowsGatewayPidsResult(
    result.pids,
    (pid) => readWindowsProcessArgsResultSync(pid),
    resolveProtectedPidAfterEnumeration(options),
  );
}

function findGatewayPidsOnPortWithProtectedPidSync(
  port: number,
  lsofTimeoutMs: number,
  processInspectionTimeoutMs: number,
  options?: CleanStaleGatewayProcessesOptions,
): number[] {
  if (process.platform === "win32") {
    // Use the shared Windows port inspection (PowerShell / netstat) with
    // command-line verification to find only openclaw gateway processes.
    return findVerifiedWindowsGatewayPidsOnPortSync(port, options);
  }
  const lsof = resolveLsofCommandSync();
  const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    env: resolveDiagnosticProcessEnv(),
    encoding: "utf8",
    timeout: lsofTimeoutMs,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    // Missing lsof is an expected state on minimal hosts. Permission and timeout
    // failures still need the diagnostic below because the binary was not simply absent.
    if (code === "ENOENT") {
      return [];
    }
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
  return parsePidsFromLsofOutput(
    res.stdout,
    processInspectionTimeoutMs,
    resolveProtectedPidAfterEnumeration(options),
  );
}

/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export function findGatewayPidsOnPortSync(port: number, spawnTimeoutMs?: number): number[] {
  // An explicit timeout keeps the existing contract: it bounds every child
  // process used by this probe. Only the default path splits slow lsof from ps.
  return findGatewayPidsOnPortWithProtectedPidSync(
    port,
    spawnTimeoutMs ?? INITIAL_LSOF_TIMEOUT_MS,
    spawnTimeoutMs ?? PROCESS_INSPECTION_TIMEOUT_MS,
  );
}

// Unknown probes distinguish permanent tool failures from retryable inspection errors.
type PollResult = { free: true } | { free: false } | { free: null; permanent: boolean };

function pollPortOnce(port: number): PollResult {
  if (process.platform === "win32") {
    return pollPortOnceWindows(port);
  }
  try {
    const lsof = resolveLsofCommandSync();
    const res = spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      env: resolveDiagnosticProcessEnv(),
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
      // user namespaces), lsof can exit 1 AND still emit partial output. Any
      // record is enough to keep the poll fail-closed, even if its PID is malformed.
      return res.stdout.trim() ? { free: false } : { free: true };
    }
    if (res.status !== 0) {
      // status > 1: runtime/permission/flag error. Cannot confirm port state —
      // treat as a transient failure and keep polling rather than falsely
      // reporting the port as free (which would recreate the EADDRINUSE race).
      return { free: null, permanent: false };
    }
    // status === 0: lsof found a listener. Occupancy does not depend on whether
    // its PID field is present, valid, or attributable to an OpenClaw process.
    return { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

// Occupancy alone matters after cleanup; keep PowerShell within the per-probe budget.
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
function terminateStaleProcessesSync(pids: number[], canSignal: () => boolean): number[] {
  if (process.platform === "win32") {
    return terminateStaleProcessesWindows(pids, canSignal);
  }
  const killed: number[] = [];
  for (const pid of pids) {
    if (!canSignal()) {
      break;
    }
    if (trySignalStaleProcess(pid, "SIGTERM")) {
      killed.push(pid);
    }
  }
  if (killed.length === 0) {
    return killed;
  }
  sleepSync(STALE_SIGTERM_WAIT_MS);
  for (const pid of killed) {
    if (isPidAlive(pid)) {
      if (!canSignal()) {
        break;
      }
      trySignalStaleProcess(pid, "SIGKILL");
    }
  }
  sleepSync(STALE_SIGKILL_WAIT_MS);
  return killed;
}

function trySignalStaleProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!hasErrnoCode(error, "ESRCH")) {
      restartLog.warn(
        `failed to send ${signal} to stale gateway process ${pid}: ${formatErrorMessage(error)}`,
      );
    }
    return false;
  }
}

/**
 * Windows-specific process termination using taskkill.
 * Sends a graceful taskkill first (/T for tree), waits, then escalates to /F.
 */
function terminateStaleProcessesWindows(pids: number[], canSignal: () => boolean): number[] {
  const taskkillPath = path.win32.join(
    getWindowsInstallRoots().systemRoot,
    "System32",
    "taskkill.exe",
  );
  const killed: number[] = [];
  for (const pid of pids) {
    if (!canSignal()) {
      break;
    }
    const graceful = spawnSync(taskkillPath, ["/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    const gracefulFailed = graceful.error != null || (graceful.status ?? 0) !== 0;
    if (!gracefulFailed && !isPidAlive(pid)) {
      killed.push(pid);
      continue;
    }
    sleepSync(STALE_SIGTERM_WAIT_MS);
    if (!isPidAlive(pid)) {
      killed.push(pid);
      continue;
    }
    if (!canSignal()) {
      break;
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
    if (!isPidAlive(pid)) {
      killed.push(pid);
    }
  }
  return killed;
}

/** Wait for a free port, a permanent inspection failure, or the wall-clock deadline. */
function waitForPortFreeSync(port: number): void {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
export function cleanStaleGatewayProcessesSync(
  portOverride?: number,
  options?: CleanStaleGatewayProcessesOptions,
): number[] {
  try {
    const ownerContext = { env: options?.env };
    if (readGatewayOwnerLease(ownerContext)) {
      return [];
    }
    const port =
      typeof portOverride === "number" && Number.isFinite(portOverride) && portOverride > 0
        ? Math.floor(portOverride)
        : resolveGatewayPort(undefined, options?.env ?? process.env);
    const stalePids =
      process.platform === "win32"
        ? (() => {
            const result = findVerifiedWindowsGatewayPidsOnPortResultSync(port, options);
            if (result.ok) {
              return result.pids;
            }
            waitForPortFreeSync(port);
            return [];
          })()
        : findGatewayPidsOnPortWithProtectedPidSync(
            port,
            INITIAL_LSOF_TIMEOUT_MS,
            PROCESS_INSPECTION_TIMEOUT_MS,
            options,
          );
    if (stalePids.length === 0 || readGatewayOwnerLease(ownerContext)) {
      return [];
    }
    restartLog.warn(
      `killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`,
    );
    const killed = terminateStaleProcessesSync(stalePids, () => {
      options?.assertCurrent?.();
      return readGatewayOwnerLease(ownerContext) === undefined;
    });
    // Even an already-exited PID can leave its socket bound briefly; always join port release.
    waitForPortFreeSync(port);
    return killed;
  } catch {
    return [];
  }
}
