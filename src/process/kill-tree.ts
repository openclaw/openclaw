import { spawn } from "node:child_process";

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * This gives child processes a chance to clean up (close connections, remove
 * temp files, terminate their own children) before being hard-killed.
 */
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const graceMs = opts?.graceMs ?? 3000;

  if (process.platform === "win32") {
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  killProcessTreeUnix(pid, graceMs);
}

function killProcessTreeUnix(pid: number, graceMs: number): void {
  // Step 1: Try graceful SIGTERM to process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group doesn't exist or we lack permission - try direct
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone
      return;
    }
  }

  // Step 2: Wait grace period, then SIGKILL if still alive
  setTimeout(() => {
    try {
      // Check if still alive by sending signal 0
      process.kill(-pid, 0);
      // Still alive - hard kill
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone now
        }
      }
    } catch {
      // Process group gone - check direct
      try {
        process.kill(pid, 0);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone
        }
      } catch {
        // Already terminated
      }
    }
  }, graceMs).unref(); // Don't block event loop exit
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  // Step 1: Try graceful termination (taskkill without /F)
  try {
    spawn("taskkill", ["/T", "/PID", String(pid)], {
      stdio: "ignore",
      detached: true,
    });
  } catch {
    // Ignore spawn failures
  }

  // Step 2: Wait grace period, then force kill if still alive
  setTimeout(() => {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // Ignore taskkill failures
    }
  }, graceMs).unref(); // Don't block event loop exit
}
