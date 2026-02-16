import { spawn } from "node:child_process";

/**
 * Best-effort process-tree termination.
 * - Windows: use taskkill /T to include descendants.
 * - Unix: try process-group kill first, then direct pid kill.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // ignore taskkill failures
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process already gone or inaccessible
    }
  }
}
