/**
 * Zombie process reaper for long-running gateway processes.
 *
 * Node.js internally tracks child processes and reaps them via libuv's
 * SIGCHLD handler.  libuv calls waitpid(process->pid, ...) for each
 * tracked child, NOT waitpid(-1, WNOHANG).  This means:
 *
 * - Tracked direct children are reaped when libuv's per-pid wait loop
 *   runs on SIGCHLD delivery.
 * - Untracked children (e.g. spawned by shell wrappers, exec helpers,
 *   or hooks that sidestep the child_process module tracking) become
 *   zombies even though they are still parented by OpenClaw.
 * - Grandchildren that exit before their parent are reparented to PID 1
 *   (tini in Docker, or systemd) and become permanent zombies unless
 *   PID 1's waitpid(-1, WNOHANG) handler is triggered (#97616).
 *
 * This module is a best-effort mitigation, not a guaranteed fix: it
 * nudges the OpenClaw process first (to reap its own untracked direct
 * children) and then PID 1 (to reap reparented grandchildren).  A
 * complete fix requires either subreaper registration + native waitpid
 * binding or a bottom-up process-tree kill that avoids the race.
 *
 * See: https://github.com/openclaw/openclaw/issues/97616
 */

import { logDebug } from "../logger.js";

const REAP_INTERVAL_MS = 30_000;

let reapTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reap zombie children via SIGCHLD delivery.
 *
 * The order matters:
 * 1. Self-SIGCHLD first: libuv's per-pid wait loop reaps tracked AND
 *    untracked direct children parented by the OpenClaw process.  The
 *    linked issue shows zombies with PPID = openclaw, so self-signal is
 *    the primary path.
 * 2. PID 1 as fallback: when process trees are killed, grandchildren
 *    that exit before their parent are reparented to PID 1 as zombies.
 *    tini's SIGCHLD handler calls waitpid(-1, WNOHANG) which can reap
 *    them.  PID 1 CANNOT reap children still parented by OpenClaw —
 *    that's why self-SIGCHLD must come first.
 *
 * On Windows this is a no-op.
 */
export function reapZombies(): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    // Primary: self-SIGCHLD triggers libuv's per-pid wait loop to reap
    // direct children (including untracked ones) still parented by us.
    process.kill(process.pid, "SIGCHLD");
  } catch {
    // Signal delivery may fail in restricted environments
    // (seccomp filters, hardened containers, etc.) — non-fatal.
  }

  try {
    // Fallback: nudge PID 1 (tini/init) to reap grandchildren that were
    // reparented after their parent exited.
    process.kill(1, "SIGCHLD");
  } catch {
    // PID 1 may not be reachable outside containers or on certain
    // platforms — non-fatal.
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
