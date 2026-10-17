// Native Node callers load this source closure without a TypeScript import resolver.
import childProcess from "node:child_process";
import fsSync from "node:fs";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.ts";
import { readWindowsProcessStartTimeSync } from "../infra/windows-process-start.ts";
import { readFreeBsdProcessStartTime } from "./freebsd-process-identity.ts";

const PROCESS_START_TIMEOUT_MS = 1000;
declare const SEALED_RUNTIME_BUILD: boolean;
function readDarwinNativeIdentity(
  pid: number,
): { startedAt: number; startTimeMicros: number } | null | undefined {
  if (
    process.platform !== "darwin" ||
    (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD)
  ) {
    return undefined;
  }
  try {
    const identity = readProcessIdentity(pid);
    // A retained zombie is not a live owner. Do not recover it through ps.
    return identity && !identity.exited
      ? {
          // Published Darwin leases use epoch seconds, not microseconds.
          startedAt: Math.floor(identity.startTimeMicros / 1_000_000),
          startTimeMicros: identity.startTimeMicros,
        }
      : null;
  } catch {
    // Sealed or unavailable native runtimes retain the bounded diagnostic path.
    return undefined;
  }
}

/** Unknown observations never prove death; Linux keeps its thread-aware procfs policy. */
function readNativeLiveness(pid: number): boolean | undefined {
  if (
    !["darwin", "win32", "freebsd"].includes(process.platform) ||
    (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD)
  ) {
    return undefined;
  }
  try {
    const identity = readProcessIdentity(pid);
    return identity !== null && !identity.exited;
  } catch (error) {
    // Visibility policy can hide an existing PID even from kill(pid, 0).
    if (
      error instanceof ProcSafeError &&
      (error.code === "helper-unavailable" || error.code === "unsupported-platform")
    ) {
      return undefined;
    }
    return true;
  }
}
// Bound corrupted/cyclic ancestry while allowing nested service supervisors.
export const MAX_ANCESTOR_WALK_DEPTH = 32;

// Cache only a successful self read: this identity lasts for the process.
// Failed reads must retry, and foreign PIDs must stay fresh to detect PID reuse.
let selfStartTime: number | null = null;

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check whether a Linux task is terminal and has no live sibling threads.
 * Missing or reaped procfs snapshots require a fresh existence probe.
 */
function isExitedLinuxProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const state = status.match(/^State:\s+(\S)/m)?.[1];
    const threads = status.match(/^Threads:[ \t]+(\d+)[ \t]*$/m)?.[1];
    if (threads !== "0") {
      // pthread_exit can leave a terminal leader with live workers. Reaping also
      // moves the last retained task from Z to X before removing its PID.
      return (state === "Z" || state === "X") && threads === "1";
    }
  } catch {
    // Reaping can remove procfs after the caller's existence probe.
  }
  // A successful read can outlive the task's signal metadata and report zero
  // threads. PID reuse or a nonleader exec can still leave a live current owner.
  try {
    process.kill(pid, 0);
  } catch (error) {
    // SAFETY: Node's process.kill reports syscall failures as ErrnoException.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  return false;
}

/** Returns true only when a positive PID exists and is not a known terminal task. */
export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM") {
      // A visibility policy can hide a live process even from the signal probe.
      return code === "ESRCH" ? (readNativeLiveness(pid) ?? false) : false;
    }
  }
  return readNativeLiveness(pid) ?? !isExitedLinuxProcess(pid);
}

/** Returns true only when the PID is invalid, missing, or a known terminal task. */
export function isPidDefinitelyDead(pid: number): boolean {
  if (!isValidPid(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      return false;
    }
    const native = readNativeLiveness(pid);
    // Without native visibility facts, FreeBSD ESRCH can still mean a hidden PID.
    return native === undefined ? process.platform !== "freebsd" : !native;
  }
  const native = readNativeLiveness(pid);
  return native === undefined ? isExitedLinuxProcess(pid) : !native;
}

function getDarwinProcessStartTime(
  pid: number,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): number | null {
  const started = performance.now();
  const native = readDarwinNativeIdentity(pid);
  if (native !== undefined) {
    return native?.startedAt ?? null;
  }
  // The default bounds ps itself; explicit deadlines also pay for native loading.
  const remainingMs =
    timeoutMs === undefined
      ? PROCESS_START_TIMEOUT_MS
      : Math.ceil(timeoutMs - (performance.now() - started));
  if (remainingMs <= 0) {
    return null;
  }
  try {
    const startedAt = childProcess
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...resolveDiagnosticProcessEnv(env), LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: remainingMs,
        killSignal: "SIGKILL",
      })
      .trim();
    // Darwin's lstart output has no timezone. Force UTC for both ps and parsing so
    // a system timezone change cannot make a live lock owner look like PID reuse.
    const startedAtMs = Date.parse(`${startedAt} UTC`);
    return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
  } catch {
    return null;
  }
}

/** Read the Linux procfs start identity used by Linux-owned runtime state. */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid) || process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

/** Custody recovery needs native birth precision rather than the shipped lease timestamp format. */
export function getProcessInstanceStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    const startedAt = getProcessStartTime(pid);
    return Number.isSafeInteger(startedAt) ? startedAt : null;
  }
  const native = readDarwinNativeIdentity(pid);
  if (!native) {
    return null;
  }
  const startedAt = native.startTimeMicros;
  return Number.isSafeInteger(startedAt) ? startedAt : null;
}

/** Read a cross-platform process identity for filesystem lock ownership. */
export function getFileLockProcessStartTime(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  const isSelf = pid === process.pid;
  if (isSelf && selfStartTime !== null) {
    return selfStartTime;
  }
  const startTime =
    process.platform === "darwin"
      ? getDarwinProcessStartTime(pid, env, timeoutMs)
      : process.platform === "win32"
        ? readWindowsProcessStartTimeSync(pid, timeoutMs, env)
        : process.platform === "freebsd"
          ? readFreeBsdProcessStartTime(pid)
          : getProcessStartTime(pid);
  if (isSelf && startTime !== null) {
    selfStartTime = startTime;
  }
  return startTime;
}
