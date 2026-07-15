// Owner identity for filesystem state that can outlive the process that wrote
// it. A PID alone is not an identity because the OS recycles it, so owners are
// pinned to the pair (pid, process start time). Reuses the platform readers
// rather than probing processes a third way.
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { readWindowsProcessStartTimeSync } from "./windows-port-pids.js";

// Windows identity costs a PowerShell/WMIC spawn, so keep the ceiling low and
// let an unreadable identity fall through to the caller's conservative branch.
const WINDOWS_START_TIME_TIMEOUT_MS = 1000;

/**
 * Reads the OS start time proving which incarnation currently holds a PID.
 * Returns null when the platform cannot answer; callers must treat that as
 * "unverifiable", never as "dead".
 */
export function readProcessStartTimeForOwnerIdentity(pid: number): number | null {
  return process.platform === "win32"
    ? readWindowsProcessStartTimeSync(pid, WINDOWS_START_TIME_TIMEOUT_MS)
    : getFileLockProcessStartTime(pid);
}
