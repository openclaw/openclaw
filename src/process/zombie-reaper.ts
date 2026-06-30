/**
 * Zombie process reaper for long-running gateway processes.
 *
 * Node.js internally tracks child processes and reaps them via libuv's
 * SIGCHLD handler.  libuv calls waitpid(process->pid, ...) for each
 * tracked child, NOT waitpid(-1, WNOHANG).  This means:
 *
 * - Node.js's own child processes are reaped when they exit.
 * - Grandchildren (spawned by those children) are NOT tracked and
 *   libuv will never reap them.
 *
 * During process-tree termination, a race can occur: grandchildren
 * exit before their parent is killed.  The zombie grandchildren are
 * reparented to PID 1 (tini in Docker, or systemd) but no new
 * SIGCHLD fires — they become permanent zombies (#97616).
 *
 * This module is a best-effort mitigation, not a guaranteed fix: it
 * nudges PID 1 (which DOES call waitpid(-1, WNOHANG) in its SIGCHLD
 * handler) to reap any newly-reparented zombies.  A complete fix
 * requires either subreaper registration + native waitpid binding
 * or a bottom-up process-tree kill that avoids the race.
 *
 * See: https://github.com/openclaw/openclaw/issues/97616
 */

import { logDebug } from "../logger.js";

const REAP_INTERVAL_MS = 30_000;

let reapTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Nudge PID 1 (tini / init) to reap zombie children.
 *
 * When a process tree is killed, grandchildren that exit before their parent
 * are reparented to PID 1 as zombies.  Unlike libuv, tini's SIGCHLD handler
 * calls waitpid(-1, WNOHANG), so sending SIGCHLD to PID 1 triggers actual
 * zombie reaping.
 *
 * Falls back to self-SIGCHLD on platforms where PID 1 cannot be signalled.
 * On Windows this is a no-op.
 */
export function reapZombies(): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    // Primary: nudge PID 1 (tini/init) which calls waitpid(-1, WNOHANG).
    process.kill(1, "SIGCHLD");
  } catch {
    // Fallback: self-SIGCHLD triggers libuv's per-pid wait loop, which
    // reaps tracked direct children but not reparented grandchildren.
    // Better than nothing; this is explicitly a mitigation.
    try {
      process.kill(process.pid, "SIGCHLD");
    } catch {
      // Signal delivery may fail in restricted environments
      // (seccomp filters, hardened containers, etc.) — non-fatal.
    }
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
