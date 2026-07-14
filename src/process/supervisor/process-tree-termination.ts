// Strict process-group termination helpers for fail-closed scope drains.
import { spawn } from "node:child_process";

const PROCESS_TREE_EXIT_POLL_INTERVAL_MS = 10;

type ProcessTreeTerminationTracker = {
  forceKillAndWait: (timeoutMs: number) => Promise<boolean>;
  probeAlive: () => Promise<boolean | undefined>;
};

/**
 * Captures the process-group identity established at spawn. Scoped POSIX runs
 * are detached group leaders, so the group remains addressable after the root
 * exits while ordinary shell pipelines and background jobs are still alive.
 */
export function createProcessTreeTerminationTracker(params: {
  pid: number | undefined;
  detached: boolean;
}): ProcessTreeTerminationTracker {
  return {
    forceKillAndWait: async (timeoutMs) =>
      await forceKillProcessTreeAndWait({ ...params, timeoutMs }),
    probeAlive: async () => probeProcessTreeAlive(params),
  };
}

export async function forceKillProcessTreeAndWait(params: {
  pid: number | undefined;
  detached: boolean;
  timeoutMs: number;
}): Promise<boolean> {
  const pid = normalizePid(params.pid);
  if (pid === undefined) {
    return false;
  }
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  if (process.platform === "win32") {
    return await forceKillWindowsProcessTreeAndWait(pid, timeoutMs);
  }
  if (!params.detached) {
    // A shared process group cannot be killed safely, and root exit alone does
    // not prove that reparented descendants exited.
    return false;
  }

  signalKnownPosixProcess(-pid, "SIGKILL");
  signalKnownPosixProcess(pid, "SIGKILL");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(-pid) && !isProcessAlive(pid)) {
      return true;
    }
    await waitForNextProbe(deadline);
  }
  return !isProcessAlive(-pid) && !isProcessAlive(pid);
}

async function forceKillWindowsProcessTreeAndWait(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    // A numeric PID is not durable ownership after root exit; fail closed
    // instead of risking taskkill against a reused PID.
    return false;
  }
  const taskkillSucceeded = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
  return taskkillSucceeded && !isProcessAlive(pid);
}

export function probeProcessTreeAlive(params: {
  pid: number | undefined;
  detached: boolean;
}): boolean | undefined {
  const pid = normalizePid(params.pid);
  if (pid === undefined) {
    return undefined;
  }
  if (process.platform === "win32") {
    // taskkill can safely own the tree only while this exact root is live. Once
    // it exits, retaining a numeric PID would poison the scope and could later
    // target an unrelated process after PID reuse.
    return isProcessAlive(pid);
  }
  if (!params.detached) {
    return isProcessAlive(pid) ? true : undefined;
  }
  return isProcessAlive(-pid) || isProcessAlive(pid);
}

function normalizePid(pid: number | undefined): number | undefined {
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function signalKnownPosixProcess(pid: number, signal: "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or no longer signalable. The following probe decides.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForNextProbe(deadline: number): Promise<void> {
  const remainingMs = Math.max(1, deadline - Date.now());
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(PROCESS_TREE_EXIT_POLL_INTERVAL_MS, remainingMs));
  });
}
