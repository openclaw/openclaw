import { spawnSync } from "node:child_process";
import fsSync from "node:fs";

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false if the proc file can't be read.
 */
function isZombieProcessLinux(pid: number): boolean {
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

/**
 * Check if a process is a zombie on macOS using ps command.
 * Returns false if the ps command fails or process doesn't exist.
 */
function isZombieProcessMac(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  const state = result.stdout.trim();
  return state.length > 0 && state[0] === "Z";
}

/**
 * Check if a process is a zombie.
 * On Linux: reads /proc/<pid>/status
 * On macOS: uses ps -o state= -p <pid>
 * Returns false on other platforms or if detection fails.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform === "linux") {
    return isZombieProcessLinux(pid);
  }
  if (process.platform === "darwin") {
    return isZombieProcessMac(pid);
  }
  return false;
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
export function getProcessStartTime(pid: number): number | null {
  if (process.platform !== "linux") {
    return null;
  }
  if (!isValidPid(pid)) {
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
