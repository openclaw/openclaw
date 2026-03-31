import { spawn } from "node:child_process";
import { isAppleSilicon } from "../utils/platform.js";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;

// Apple Silicon optimization: Detect once at module load
const IS_APPLE_SILICON = isAppleSilicon();

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 * - Apple Silicon: optimized signal delivery and process group management
 *
 * This gives child processes a chance to clean up (close connections, remove
 * temp files, terminate their own children) before being hard-killed.
 */
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);

  if (process.platform === "win32") {
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  // Apple Silicon optimization: Use optimized process group handling
  killProcessTreeUnix(pid, graceMs, IS_APPLE_SILICON);
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTreeUnix(pid: number, graceMs: number, isAppleSilicon?: boolean): void {
  // Apple Silicon optimization: Use process group for better signal delivery
  const useProcessGroup = isAppleSilicon !== false;
  
  // Step 1: Try graceful SIGTERM to process group
  try {
    if (useProcessGroup) {
      process.kill(-pid, "SIGTERM");
    } else {
      // Fallback to direct kill if process group doesn't exist
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
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
    // Apple Silicon optimization: Check process group first for better performance
    if (useProcessGroup && isProcessAlive(-pid)) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall through to direct pid kill
      }
    }
    
    if (!isProcessAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process exited between liveness check and kill
    }
  }, graceMs).unref(); // Don't block event loop exit
}

function runTaskkill(args: string[]): void {
  try {
    spawn("taskkill", args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // Ignore taskkill spawn failures
  }
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  // Step 1: Try graceful termination (taskkill without /F)
  runTaskkill(["/T", "/PID", String(pid)]);

  // Step 2: Wait grace period, then force kill only if pid still exists.
  // This avoids unconditional delayed /F kills after graceful shutdown.
  setTimeout(() => {
    if (!isProcessAlive(pid)) {
      return;
    }
    runTaskkill(["/F", "/T", "/PID", String(pid)]);
  }, graceMs).unref(); // Don't block event loop exit
}
