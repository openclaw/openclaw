import fsSync from "node:fs";

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
  if (!Number.isFinite(pid) || pid <= 0) {
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
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = parseInt(fields[19], 10);
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}
