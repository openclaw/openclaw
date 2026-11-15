import type { ChildProcess } from "node:child_process";
import { hasErrnoCode } from "../infra/errno.js";
import { signalProcessTree } from "./kill-tree.js";
import { scheduleAdoptedChildZombieReapAfterExit } from "./scoped-child-reaper.js";
import { isProcessGroupGoneByCensus } from "./supervisor/service-child-group-ownership.js";

export function shouldDetachChildForProcessTree(): boolean {
  return process.platform !== "win32";
}

// Linux PID_MAX_LIMIT: the kernel always answers ESRCH for a group this large.
const LINUX_PID_MAX_LIMIT = 4_194_304;

/**
 * Linux hosts can deny negative-PID kill(2) (OpenShell's seccomp rule) with EPERM. A kernel EPERM
 * (a member owned by another UID) proves the group has members, so the denial is only believed
 * when a group that cannot exist is refused with EPERM too, for the same signal as the failing
 * call (a filter can allow signal 0 and deny real signals). The kernel answers that group with
 * ESRCH, so nothing is delivered. Not cached: the answer is per host call.
 */
export function isDeniedProcessGroupProbe(error: unknown, signal: NodeJS.Signals | 0 = 0): boolean {
  if (process.platform !== "linux" || !hasErrnoCode(error, "EPERM")) {
    return false;
  }
  try {
    process.kill(-(LINUX_PID_MAX_LIMIT + 1), signal);
    return false;
  } catch (canary) {
    return hasErrnoCode(canary, "EPERM");
  }
}

/** Decides group extinction for `isChildProcessTreeAlive` and spawn-broker cleanup; other probes keep their own EPERM policies. */
export function isProcessGroupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    if (hasErrnoCode(error, "ESRCH")) {
      return true;
    }
    // EPERM is not evidence on its own (it also means a member owned by another UID): the census decides.
    return isDeniedProcessGroupProbe(error) ? isProcessGroupGoneByCensus(pgid) : false;
  }
}

export function isChildProcessTreeAlive(child: Pick<ChildProcess, "pid">): boolean {
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return false;
  }
  if (shouldDetachChildForProcessTree()) {
    return !isProcessGroupGone(child.pid);
  }
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. Permission or probe failures must retain cleanup.
    return !hasErrnoCode(error, "ESRCH");
  }
}

export function signalChildProcessTree(
  child: Pick<ChildProcess, "kill" | "pid" | "exitCode" | "signalCode" | "once">,
  signal: "SIGTERM" | "SIGKILL",
  onComplete?: () => void,
): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    const usedProcessGroup = shouldDetachChildForProcessTree();
    signalProcessTree(child.pid, signal, {
      detached: usedProcessGroup,
      onComplete,
    });
    // Tree kills can leave already-exited descendants reparented to us as
    // untracked zombies (#97616). Reap after the Node-tracked root exits so
    // libuv keeps ownership of its wait status — never waitpid the root, and
    // never waitpid(-1).
    scheduleAdoptedChildZombieReapAfterExit(child, usedProcessGroup);
    return;
  }

  try {
    child.kill(signal);
  } finally {
    onComplete?.();
  }
}

export function forceKillChildProcessTree(
  child: Pick<ChildProcess, "kill" | "pid" | "exitCode" | "signalCode" | "once">,
): void {
  signalChildProcessTree(child, "SIGKILL");
}
