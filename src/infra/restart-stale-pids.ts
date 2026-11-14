import { spawnSync } from "node:child_process";
import path from "node:path";
import { formatErrorMessage as formatRawErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { readProcessAncestry } from "@openclaw/proc-safe/identity";
import { resolveGatewayPort } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readUnixProcessGroupMembers, signalProcessTree } from "../process/kill-tree.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
  MAX_ANCESTOR_WALK_DEPTH,
  readLinuxProcessStat,
} from "../shared/pid-alive.js";
import { sleep } from "../utils/sleep.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import { readGatewayOwnerLease, readGatewayOwnerLeaseAsync } from "./gateway-owner-lease.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import { resolveLsofCommandSync } from "./ports-lsof.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { spawnPsSync } from "./spawn-ps.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import { getWindowsInstallRoots } from "./windows-install-roots.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsListeningPidsResultSync,
  readWindowsProcessArgsResultSync,
  readWindowsProcessArgsSync,
  type WindowsProcessArgsResult,
  type WindowsListeningPidsResult,
} from "./windows-port-pids.js";

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
  const inspectionSignal = resolveSqliteInspectionSignal(getAsyncWorkSignal());
  const ownerContext = { env: options.env };
  if (await readGatewayOwnerLeaseAsync({ ...ownerContext, signal: inspectionSignal })) {
    return [];
  }
  const targets = Array.from(
    new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
  ).map((pid) => ({ pid, startedAt: getFileLockProcessStartTime(pid, options.env) }));
  const canSignal = async (target: (typeof targets)[number]) => {
    if (
      target.startedAt === null ||
      isPidDefinitelyDead(target.pid) ||
      (await readGatewayOwnerLeaseAsync({ ...ownerContext, signal: inspectionSignal })) ||
      getFileLockProcessStartTime(target.pid, options.env) !== target.startedAt
    ) {
      return false;
    }
    inspectionSignal?.throwIfAborted();
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
    if (await canSignal(target)) {
      await signal(target.pid, "SIGTERM");
      signaled.push({ target, members: members.filter(({ pid }) => currentMembers.has(pid)) });
    }
  }
  if (signaled.length > 0) {
    await sleep(300, inspectionSignal);
    for (const { members } of signaled) {
      // Keep exact member identities after leader exit; never expand a recycled group.
      for (const member of members) {
        if (await canSignal(member)) {
          await signal(member.pid, "SIGKILL", false);
        }
      }
    }
    await sleep(200, inspectionSignal);
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

function inspectProcfsAncestors(
  pids: Set<number>,
  options: { requireVerifiedParent?: boolean; throughPid?: number },
): { pids: Set<number>; complete: boolean } {
  let pid = process.pid;
  let current = readLinuxProcessStat(pid);
  const seen = new Set([pid]);
  for (let depth = 0; current && depth < MAX_ANCESTOR_WALK_DEPTH + 2; depth++) {
    if (pid === options.throughPid || current.parentPid <= 1) {
      if (current.parentPid === 1) {
        pids.add(1);
      }
      return { pids, complete: true };
    }
    const parentPid = current.parentPid;
    if (seen.has(parentPid)) {
      break;
    }
    const parent = readLinuxProcessStat(parentPid);
    if (!parent || parent.startedAt > current.startedAt) {
      if (!parent && !options.requireVerifiedParent) {
        pids.add(parentPid);
      }
      break;
    }
    pids.add(parentPid);
    seen.add(parentPid);
    pid = parentPid;
    current = parent;
  }
  return { pids, complete: false };
}

type AncestorIdentity = { pid: number; parentPid: number; startTimeMicros: number };

/** The kernel process table still exposes a root-owned parent's PPID and start second. */
function readDarwinHiddenParentSync(pid: number, timeoutMs: number): AncestorIdentity | null {
  const result = spawnSync("ps", ["-o", "ppid=,lstart=", "-p", String(pid)], {
    env: { ...resolveDiagnosticProcessEnv(), LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
  const match = /^\s*(\d+)\s+(\S.*\S)\s*$/u.exec(result.stdout ?? "");
  const startedAt = Date.parse(`${match?.[2]} UTC`);
  return result.status === 0 && match && Number.isFinite(startedAt)
    ? { pid, parentPid: Number(match[1]), startTimeMicros: startedAt * 1000 }
    : null;
}

/**
 * Darwin denies identity reads for root-owned setuid ancestors (login, sudo, sshd),
 * so a Terminal shell's native walk stops below launchd. Resume it through ps,
 * keeping start ordering at ps's one-second resolution.
 */
function resumeDarwinAncestry(
  chain: AncestorIdentity[],
  maxDepth: number,
  throughPid: number | undefined,
  timeoutMs: number,
): boolean {
  while (chain.length < maxDepth) {
    const child = chain.at(-1)!;
    const hidden = readDarwinHiddenParentSync(child.parentPid, timeoutMs);
    if (!hidden || hidden.startTimeMicros > child.startTimeMicros) {
      return false;
    }
    chain.push(hidden);
    if (hidden.pid === throughPid || hidden.parentPid <= 1) {
      return true;
    }
    let next: ReturnType<typeof readProcessAncestry>;
    try {
      next = readProcessAncestry(hidden.parentPid, {
        maxDepth: maxDepth - chain.length,
        ...(throughPid === undefined ? {} : { throughPid }),
      });
    } catch {
      // Another root-owned ancestor: read it through ps on the next pass.
      continue;
    }
    if (!next || next.chain[0]!.startTimeMicros >= hidden.startTimeMicros + 1_000_000) {
      return false;
    }
    chain.push(...next.chain);
    if (next.stoppedBy !== "unreadable-parent") {
      return next.complete;
    }
  }
  return false;
}

/** Protect the caller and every known ancestor, including an unreadable parent, from cleanup. */
export function inspectSelfAndAncestorPidsSync(
  spawnTimeoutMs = PROCESS_INSPECTION_TIMEOUT_MS,
  options: { requireVerifiedParent?: boolean; throughPid?: number } = {},
): { pids: Set<number>; complete: boolean } {
  const pids = new Set<number>([process.pid]);
  const immediateParent = process.ppid;
  if (
    !options.requireVerifiedParent &&
    Number.isSafeInteger(immediateParent) &&
    immediateParent > 0
  ) {
    pids.add(immediateParent);
  }
  // The native walker deliberately never queries init/launchd.
  if (process.pid === 1) {
    return { pids, complete: true };
  }
  try {
    const maxDepth = MAX_ANCESTOR_WALK_DEPTH + 2;
    const ancestry = readProcessAncestry(process.pid, {
      maxDepth,
      ...(options.throughPid === undefined ? {} : { throughPid: options.throughPid }),
    });
    if (!ancestry) {
      return { pids, complete: false };
    }
    const chain: AncestorIdentity[] = [...ancestry.chain];
    let complete = ancestry.complete;
    let stoppedUnreadable = ancestry.stoppedBy === "unreadable-parent";
    if (stoppedUnreadable && process.platform === "darwin") {
      complete = resumeDarwinAncestry(chain, maxDepth, options.throughPid, spawnTimeoutMs);
      stoppedUnreadable = !complete;
    }
    for (const identity of chain) {
      pids.add(identity.pid);
    }
    const parentPid = chain.at(-1)?.parentPid;
    if (parentPid === 1 || (!options.requireVerifiedParent && stoppedUnreadable && parentPid)) {
      pids.add(parentPid);
    }
    return { pids, complete };
  } catch {
    // Older glibc hosts can read the same kernel identities without loading proc-safe.
    return inspectProcfsAncestors(pids, options);
  }
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
    const args = readUnixProcessArgsSync(pid, spawnTimeoutMs);
    if (
      args != null &&
      classifyOpenClawArgv(args, { command: "gateway", pid }).kind === "openclaw"
    ) {
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

type VerifiedWindowsGatewayPidsResult =
  | { ok: true; pids: number[]; starts: ReadonlyMap<number, number> }
  | Extract<WindowsListeningPidsResult, { ok: false }>;

function filterVerifiedWindowsGatewayPidsResult(
  rawPids: number[],
  processArgsResult: (pid: number) => WindowsProcessArgsResult,
  protectedPid?: number,
  env?: NodeJS.ProcessEnv,
): VerifiedWindowsGatewayPidsResult {
  const excluded = getExcludedGatewayPidsSync(PROCESS_INSPECTION_TIMEOUT_MS, protectedPid);
  const verified: number[] = [];
  const starts = new Map<number, number>();
  for (const pid of uniqueValues(rawPids)) {
    if (!Number.isFinite(pid) || pid <= 0 || excluded.has(pid)) {
      continue;
    }
    // Bracket the argv observation: a later PID occupant must not inherit the
    // Gateway eligibility established by the process whose argv we inspected.
    const startedAt = getFileLockProcessStartTime(pid, env);
    if (startedAt == null) {
      continue;
    }
    const argsResult = processArgsResult(pid);
    if (!argsResult.ok) {
      return { ok: false, permanent: argsResult.permanent };
    }
    if (
      verifyWindowsGatewayArgv(pid, argsResult.args) &&
      getFileLockProcessStartTime(pid, env) === startedAt
    ) {
      verified.push(pid);
      starts.set(pid, startedAt);
    }
  }
  return { ok: true, pids: verified, starts };
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

function findVerifiedWindowsGatewayPidsOnPortResultSync(
  port: number,
  options?: CleanStaleGatewayProcessesOptions,
): VerifiedWindowsGatewayPidsResult {
  const result = readWindowsListeningPidsResultSync(port);
  if (!result.ok) {
    return result;
  }
  return filterVerifiedWindowsGatewayPidsResult(
    result.pids,
    (pid) => readWindowsProcessArgsResultSync(pid),
    resolveProtectedPidAfterEnumeration(options),
    options?.env,
  );
}

function scanListeningPort(port: number, timeout: number) {
  const lsof = resolveLsofCommandSync();
  return spawnSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    env: resolveDiagnosticProcessEnv(),
    encoding: "utf8",
    timeout,
  });
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
    const rawPids = readWindowsListeningPidsOnPortSync(port);
    return filterVerifiedWindowsGatewayPids(rawPids, resolveProtectedPidAfterEnumeration(options));
  }
  const res = scanListeningPort(port, lsofTimeoutMs);
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    // Missing lsof is an expected state on minimal hosts. Permission and timeout
    // failures still need the diagnostic below because the binary was not simply absent.
    if (code === "ENOENT") {
      return [];
    }
    const detail = code && code.trim().length > 0 ? code : res.error.message;
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
type PollResult = { free: boolean } | { free: null; permanent: boolean };

function pollPortOnce(port: number): PollResult {
  try {
    if (process.platform === "win32") {
      // Occupancy alone matters after cleanup; keep PowerShell within the per-probe budget.
      const result = readWindowsListeningPidsResultSync(port, POLL_SPAWN_TIMEOUT_MS);
      return result.ok
        ? { free: result.pids.length === 0 }
        : { free: null, permanent: result.permanent };
    }
    const res = scanListeningPort(port, POLL_SPAWN_TIMEOUT_MS);
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

/** Native and async drivers share signals, fresh admission points, and wait budgets. */
type StaleGatewayCleanupStep = { type: "lease" } | { type: "wait"; ms: number };
type StaleGatewayCleanupSteps<T> = Generator<
  StaleGatewayCleanupStep,
  T,
  GatewayOwnerLeaseIdentity | undefined
>;

function* canSignalStaleProcess(
  pid: number,
  starts: ReadonlyMap<number, number | null>,
  options: CleanStaleGatewayProcessesOptions | undefined,
  assertCurrent: () => void,
): StaleGatewayCleanupSteps<boolean> {
  const owner = yield { type: "lease" };
  if (owner) {
    return false;
  }
  const startedAt = starts.get(pid);
  if (startedAt == null || getFileLockProcessStartTime(pid, options?.env) !== startedAt) {
    restartLog.warn(
      `stale gateway process pid ${pid} identity changed or unavailable; process preserved`,
    );
    return false;
  }
  assertCurrent();
  return true;
}

function* terminateStaleProcesses(
  pids: number[],
  starts: ReadonlyMap<number, number | null>,
  options: CleanStaleGatewayProcessesOptions | undefined,
  assertCurrent: () => void,
): StaleGatewayCleanupSteps<number[]> {
  if (process.platform === "win32") {
    return yield* terminateStaleProcessesWindows(pids, starts, options, assertCurrent);
  }
  const killed: number[] = [];
  for (const pid of pids) {
    if (!(yield* canSignalStaleProcess(pid, starts, options, assertCurrent))) {
      break;
    }
    if (trySignalStaleProcess(pid, "SIGTERM")) {
      killed.push(pid);
    }
  }
  if (killed.length === 0) {
    return killed;
  }
  yield { type: "wait", ms: STALE_SIGTERM_WAIT_MS };
  for (const pid of killed) {
    if (isPidAlive(pid)) {
      if (!(yield* canSignalStaleProcess(pid, starts, options, assertCurrent))) {
        break;
      }
      trySignalStaleProcess(pid, "SIGKILL");
    }
  }
  yield { type: "wait", ms: STALE_SIGKILL_WAIT_MS };
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
function* terminateStaleProcessesWindows(
  pids: number[],
  starts: ReadonlyMap<number, number | null>,
  options: CleanStaleGatewayProcessesOptions | undefined,
  assertCurrent: () => void,
): StaleGatewayCleanupSteps<number[]> {
  const taskkillPath = path.win32.join(
    getWindowsInstallRoots().systemRoot,
    "System32",
    "taskkill.exe",
  );
  const taskkill = (args: string[]) =>
    spawnSync(taskkillPath, args, { stdio: "ignore", timeout: 5000, windowsHide: true });
  const killed: number[] = [];
  for (const pid of pids) {
    if (!(yield* canSignalStaleProcess(pid, starts, options, assertCurrent))) {
      break;
    }
    const graceful = taskkill(["/T", "/PID", String(pid)]);
    const gracefulFailed = graceful.error != null || (graceful.status ?? 0) !== 0;
    if (!gracefulFailed && !isPidAlive(pid)) {
      killed.push(pid);
      continue;
    }
    yield { type: "wait", ms: STALE_SIGTERM_WAIT_MS };
    if (!isPidAlive(pid)) {
      killed.push(pid);
      continue;
    }
    if (!(yield* canSignalStaleProcess(pid, starts, options, assertCurrent))) {
      break;
    }
    const forced = taskkill(["/F", "/T", "/PID", String(pid)]);
    if (forced.error != null || (forced.status ?? 0) !== 0) {
      continue;
    }
    yield { type: "wait", ms: STALE_SIGKILL_WAIT_MS };
    if (!isPidAlive(pid)) {
      killed.push(pid);
    }
  }
  return killed;
}

/** Wait for a free port, a permanent inspection failure, or the wall-clock deadline. */
function* waitForPortFree(port: number): StaleGatewayCleanupSteps<void> {
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
    yield { type: "wait", ms: PORT_FREE_POLL_INTERVAL_MS };
  }
  restartLog.warn(`port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`);
}

/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Join port release (or the poll budget) so
 * the supervisor (systemd / launchctl) does not race a zombie process for
 * the port and enter an EADDRINUSE restart loop.
 *
 * Drivers resolve each yielded lease before native effects; asynchronous callers also yield waits.
 */
function* cleanStaleGatewayProcessesSteps(
  portOverride: number | undefined,
  options: CleanStaleGatewayProcessesOptions | undefined,
  assertCurrent: () => void,
): StaleGatewayCleanupSteps<number[]> {
  if (yield { type: "lease" }) {
    return [];
  }
  const port =
    typeof portOverride === "number" && Number.isFinite(portOverride) && portOverride > 0
      ? Math.floor(portOverride)
      : resolveGatewayPort(undefined, options?.env ?? process.env);
  let starts: ReadonlyMap<number, number | null> = new Map();
  const stalePids =
    process.platform === "win32"
      ? (() => {
          const result = findVerifiedWindowsGatewayPidsOnPortResultSync(port, options);
          if (result.ok) {
            starts = result.starts;
            return result.pids;
          }
          return undefined;
        })()
      : findGatewayPidsOnPortWithProtectedPidSync(
          port,
          INITIAL_LSOF_TIMEOUT_MS,
          PROCESS_INSPECTION_TIMEOUT_MS,
          options,
        );
  if (!stalePids) {
    yield* waitForPortFree(port);
    return [];
  }
  if (process.platform !== "win32") {
    starts = new Map(stalePids.map((pid) => [pid, getFileLockProcessStartTime(pid, options?.env)]));
  }
  if (stalePids.length === 0 || (yield { type: "lease" })) {
    return [];
  }
  restartLog.warn(
    `killing ${stalePids.length} stale gateway process(es) before restart: ${stalePids.join(", ")}`,
  );
  const killed = yield* terminateStaleProcesses(stalePids, starts, options, assertCurrent);
  // Even an already-exited PID can leave its socket bound briefly; always join port release.
  yield* waitForPortFree(port);
  return killed;
}

function reportStaleGatewayCleanupFailure(error: unknown): number[] {
  restartLog.warn(`stale gateway process cleanup failed: ${formatRawErrorMessage(error)}`);
  return [];
}

/** The native supervisor restart callback retains its synchronous execution contract. */
export function cleanStaleGatewayProcessesSync(
  portOverride?: number,
  options?: CleanStaleGatewayProcessesOptions,
): number[] {
  try {
    const operation = cleanStaleGatewayProcessesSteps(portOverride, options, () =>
      options?.assertCurrent?.(),
    );
    let next = operation.next();
    while (!next.done) {
      if (next.value.type === "lease") {
        next = operation.next(readGatewayOwnerLease({ env: options?.env }));
      } else {
        sleepSync(next.value.ms);
        next = operation.next(undefined);
      }
    }
    return next.value;
  } catch (error) {
    return reportStaleGatewayCleanupFailure(error);
  }
}

/** Doctor and service inspection await private source preparation and remain cancellable. */
export async function cleanStaleGatewayProcesses(
  portOverride?: number,
  options?: CleanStaleGatewayProcessesOptions,
): Promise<number[]> {
  const signal = resolveSqliteInspectionSignal(getAsyncWorkSignal());
  try {
    signal?.throwIfAborted();
    const operation = cleanStaleGatewayProcessesSteps(portOverride, options, () => {
      signal?.throwIfAborted();
      options?.assertCurrent?.();
    });
    let next = operation.next();
    while (!next.done) {
      let owner: GatewayOwnerLeaseIdentity | undefined;
      if (next.value.type === "lease") {
        owner = await readGatewayOwnerLeaseAsync({ env: options?.env, signal });
      } else {
        await sleep(next.value.ms, signal);
      }
      signal?.throwIfAborted();
      next = operation.next(owner);
    }
    return next.value;
  } catch (error) {
    signal?.throwIfAborted();
    return reportStaleGatewayCleanupFailure(error);
  }
}
