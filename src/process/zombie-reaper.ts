/**
 * Zombie process reaper for long-running gateway processes.
 *
 * Node.js internally tracks child processes and reaps them via libuv's
 * SIGCHLD handler (which calls waitpid(-1, WNOHANG) in a loop). However,
 * when grandchildren exit before their parent is killed (a race during
 * process-tree termination), the zombie grandchildren are reparented to
 * PID 1 (or the nearest subreaper) but no new SIGCHLD is sent — they
 * become permanent zombies.
 *
 * This module provides two safeguards:
 *
 * 1. After kill-tree operations, call `reapZombies()` to trigger an
 *    immediate libuv waitpid sweep by sending SIGCHLD to ourselves.
 *    This reaps any zombies that were reparented to us.
 *
 * 2. A periodic fallback timer (every 30s) that triggers the same sweep,
 *    catching any zombies that accumulated outside kill-tree paths.
 *
 * Note: `process.kill(process.pid, 'SIGCHLD')` is safe because it merely
 * triggers libuv's existing signal handler — libuv's waitpid(-1, WNOHANG)
 * loop silently ignores any PID it doesn't track, and the handler does
 * not recurse.
 *
 * See: https://github.com/openclaw/openclaw/issues/97616
 */

import { logDebug } from "../logger.js";

const REAP_INTERVAL_MS = 30_000;

let reapTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Send SIGCHLD to the current process to trigger libuv's internal
 * waitpid(-1, WNOHANG) loop. This reaps any zombie children (including
 * reparented grandchildren if this process is a subreaper or PID 1).
 *
 * Safe to call from any context — if we're on an unsupported platform
 * (Windows) or the signal is blocked by seccomp/SELinux, the call is
 * a silent no-op.
 */
export function reapZombies(): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    process.kill(process.pid, "SIGCHLD");
  } catch {
    // Signal delivery may fail in restricted environments
    // (seccomp filters, hardened containers, etc.) — non-fatal.
  }
}

/**
 * Start the periodic zombie reaper. Safe to call multiple times
 * (idempotent). Only activates on Linux/macOS.
 */
export function startZombieReaper(): void {
  if (process.platform === "win32") {
    return;
  }
  if (reapTimer) {
    return;
  }
  logDebug("zombie-reaper: starting periodic reaper");
  reapTimer = setInterval(() => {
    reapZombies();
  }, REAP_INTERVAL_MS);
  // Don't hold the event loop open for the reaper timer.
  reapTimer.unref();
}

/**
 * Stop the periodic zombie reaper (for graceful shutdown / testing).
 */
export function stopZombieReaper(): void {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}
