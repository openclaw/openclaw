/**
 * Plugin-facing heartbeat and timeout timer seam for delegated tasks.
 *
 * Provides a public API for plugins to schedule heartbeat cadence and timeout
 * cleanup without importing internal core timers directly. Teardown is explicit
 * — calling `cancel()` or `destroy()` clears all held timers.
 *
 * @module delegated-task-watchdog
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("plugins/delegated-task-watchdog");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DelegatedTaskWatchdogConfig = {
  /** Unique task identifier for logging and correlation. */
  taskId: string;
  /** Interval in milliseconds between heartbeat ticks. Must be > 0. */
  heartbeatCadenceMs: number;
  /**
   * Absolute deadline in epoch-ms. When reached, `onTimeout` fires and the
   * watchdog auto-destroys. If omitted the watchdog runs indefinitely until
   * manually cancelled.
   */
  deadlineAtMs?: number;
  /**
   * Called on each heartbeat tick. Receives the elapsed time since start and
   * the remaining time until deadline (Infinity when no deadline is set).
   */
  onHeartbeat?: (ctx: WatchdogHeartbeatContext) => void;
  /**
   * Called exactly once when the deadline is reached or when `extend()` is
   * called with a new deadline that has already passed. After this fires the
   * watchdog is auto-destroyed.
   */
  onTimeout?: (ctx: WatchdogTimeoutContext) => void;
};

export type WatchdogHeartbeatContext = {
  taskId: string;
  startedAtMs: number;
  elapsedMs: number;
  remainingMs: number;
  tickNumber: number;
};

export type WatchdogTimeoutContext = {
  taskId: string;
  startedAtMs: number;
  elapsedMs: number;
  reason: "deadline" | "manual";
};

export type DelegatedTaskWatchdogHandle = {
  /** The task id this handle was created for. */
  readonly taskId: string;
  /** Whether the watchdog is still active (not cancelled / not timed out). */
  readonly active: boolean;
  /** Extend the deadline to a new absolute epoch-ms. */
  extend(newDeadlineAtMs: number): void;
  /** Cancel the watchdog immediately. All timers are cleared. `onTimeout` is NOT fired. */
  cancel(): void;
  /**
   * Destroy the watchdog. Unlike cancel, this fires `onTimeout` with
   * reason "manual" if a handler is registered and the watchdog was active.
   */
  destroy(): void;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MIN_HEARTBEAT_MS = 1;

export function createDelegatedTaskWatchdog(
  config: DelegatedTaskWatchdogConfig,
): DelegatedTaskWatchdogHandle {
  const { taskId, heartbeatCadenceMs, onHeartbeat, onTimeout } = config;

  if (heartbeatCadenceMs < MIN_HEARTBEAT_MS) {
    throw new Error(
      `DelegatedTaskWatchdog heartbeatCadenceMs must be >= ${MIN_HEARTBEAT_MS}, got ${heartbeatCadenceMs}`,
    );
  }

  const startedAtMs = Date.now();
  let deadlineAtMs = config.deadlineAtMs;
  let tickNumber = 0;
  let active = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  function fireTimeoutAndCleanup(reason: WatchdogTimeoutContext["reason"]): void {
    if (!active) return;
    active = false;
    clearTimers();
    try {
      onTimeout?.({
        taskId,
        startedAtMs,
        elapsedMs: Date.now() - startedAtMs,
        reason,
      });
    } catch (err) {
      log.warn("DelegatedTaskWatchdog onTimeout handler threw", {
        taskId,
        error: String(err),
      });
    }
  }

  // --- Heartbeat interval ---
  heartbeatTimer = setInterval(() => {
    if (!active) return;
    tickNumber += 1;
    const elapsedMs = Date.now() - startedAtMs;
    const remainingMs = deadlineAtMs != null ? Math.max(0, deadlineAtMs - Date.now()) : Infinity;
    try {
      onHeartbeat?.({ taskId, startedAtMs, elapsedMs, remainingMs, tickNumber });
    } catch (err) {
      log.warn("DelegatedTaskWatchdog onHeartbeat handler threw", {
        taskId,
        tick: tickNumber,
        error: String(err),
      });
    }
  }, heartbeatCadenceMs);

  // Unref timers so they don't keep the Node.js event loop alive.
  // This matches the behaviour of core-internal timers used for agent waits.
  if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    heartbeatTimer.unref();
  }

  // --- Deadline timeout (optional) ---
  if (deadlineAtMs != null) {
    const delay = Math.max(0, deadlineAtMs - Date.now());
    timeoutTimer = setTimeout(() => {
      fireTimeoutAndCleanup("deadline");
    }, delay);
    if (typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
      timeoutTimer.unref();
    }
  }

  return {
    get taskId() {
      return taskId;
    },
    get active() {
      return active;
    },
    extend(newDeadlineAtMs: number): void {
      if (!active) return;
      deadlineAtMs = newDeadlineAtMs;
      // Clear existing timeout and set a new one.
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const delay = Math.max(0, newDeadlineAtMs - Date.now());
      if (delay === 0) {
        // Already past the new deadline — fire immediately.
        fireTimeoutAndCleanup("deadline");
        return;
      }
      timeoutTimer = setTimeout(() => {
        fireTimeoutAndCleanup("deadline");
      }, delay);
      if (typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
        timeoutTimer.unref();
      }
    },
    cancel(): void {
      if (!active) return;
      active = false;
      clearTimers();
    },
    destroy(): void {
      fireTimeoutAndCleanup("manual");
    },
  };
}
