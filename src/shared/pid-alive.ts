import { execFileSync } from "node:child_process";
import fsSync from "node:fs";

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (isZombieProcess(pid)) {
    return false;
  }
  return true;
}

/**
 * Read the process start time (field 22 "starttime") from /proc/<pid>/stat.
 * Returns the value in clock ticks since system boot, or null on non-Linux
 * platforms or if the proc file can't be read.
 *
 * This is used to detect PID recycling: if two readings for the same PID
 * return different starttimes, the PID has been reused by a different process.
 */
/**
 * Read the process start time from platform-specific sources.
 *
 * - Linux: reads field 22 ("starttime") from /proc/<pid>/stat (clock ticks
 *   since boot).
 * - macOS (Darwin): parses output from `ps -o lstart= -p <pid>` and returns
 *   a Unix timestamp in milliseconds.
 *
 * Returns a comparable numeric value, or null if the platform is unsupported
 * or the data can't be read. The actual unit varies by platform, but for any
 * given platform two calls for the same PID will return the same value if
 * (and only if) the process hasn't been replaced.
 */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    return getProcessStartTimeLinux(pid);
  }
  if (process.platform === "darwin") {
    return getProcessStartTimeDarwin(pid);
  }
  return null;
}

function getProcessStartTimeLinux(pid: number): number | null {
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

function getProcessStartTimeDarwin(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) {
      return null;
    }
    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
