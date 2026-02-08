import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";
import { CommandLane } from "./lanes.js";

// Minimal in-process queue to serialize command executions.
// Default lane ("main") preserves the existing behavior. Additional lanes allow
// low-risk parallelism (e.g. cron jobs) without interleaving stdin / logs for
// the main auto-reply workflow.

type QueueEntry = {
  task: (signal?: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  active: number;
  maxConcurrent: number;
  draining: boolean;
  abortControllers: Set<AbortController>;
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    active: 0,
    maxConcurrent: 1,
    draining: false,
    abortControllers: new Set<AbortController>(),
  };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    return;
  }
  state.draining = true;

  const pump = () => {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry;
      const waitedMs = Date.now() - entry.enqueuedAt;
      if (waitedMs >= entry.warnAfterMs) {
        entry.onWait?.(waitedMs, state.queue.length);
        diag.warn(
          `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${state.queue.length}`,
        );
      }
      logLaneDequeue(lane, waitedMs, state.queue.length);
      state.active += 1;

      // Create new AbortController for this task
      const controller = new AbortController();
      state.abortControllers.add(controller);

      void (async () => {
        const startTime = Date.now();
        try {
          // Pass abort signal to task
          const result = await entry.task(controller.signal);
          state.active -= 1;
          // Remove abortController when task completes
          state.abortControllers.delete(controller);
          diag.debug(
            `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.active} queued=${state.queue.length}`,
          );
          pump();
          entry.resolve(result);
        } catch (err) {
          state.active -= 1;
          // Remove abortController when task completes (even on error)
          state.abortControllers.delete(controller);
          const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
          // Don't log error if task was aborted intentionally
          if (!isProbeLane && !controller.signal.aborted) {
            diag.error(
              `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
            );
          } else if (controller.signal.aborted) {
            diag.debug(`lane task aborted: lane=${lane} durationMs=${Date.now() - startTime}`);
          }
          pump();
          entry.reject(err);
        }
      })();
    }
    state.draining = false;
  };

  pump();
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: (signal?: AbortSignal) => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  const cleaned = lane.trim() || CommandLane.Main;
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task, // Pass the task that accepts optional AbortSignal
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, state.queue.length + state.active);
    drainLane(cleaned);
  });
}

export function enqueueCommand<T>(
  task: (signal?: AbortSignal) => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = lane.trim() || CommandLane.Main;
  const state = lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return state.queue.length + state.active;
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.queue.length + s.active;
  }
  return total;
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  state.queue.length = 0;
  // Also abort any active task in the lane
  abortActiveTaskInLane(cleaned);
  return removed;
}

/**
 * Abort the currently active task in a lane (if any).
 * This allows /stop to immediately terminate long-running tasks.
 *
 * @param lane - The lane to abort the active task in
 * @returns true if an active task was aborted, false otherwise
 */
export function abortActiveTaskInLane(lane: string = CommandLane.Main): boolean {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = lanes.get(cleaned);
  if (!state) {
    return false;
  }
  // Abort all active tasks (supports concurrency)
  if (state.active > 0 && state.abortControllers.size > 0) {
    for (const controller of state.abortControllers) {
      controller.abort();
    }
    state.abortControllers.clear();
    diag.debug(`lane active task aborted: lane=${cleaned} count=${state.active}`);
    return true;
  }
  return false;
}

/**
 * Get information about active tasks in a lane.
 * Useful for debugging and monitoring.
 *
 * @param lane - The lane to query
 * @returns Object with active task count and abort status
 */
export function getLaneActiveInfo(lane: string = CommandLane.Main): {
  active: number;
  hasActiveAbortController: boolean;
  aborted: boolean;
} {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = lanes.get(cleaned);
  if (!state) {
    return { active: 0, hasActiveAbortController: false, aborted: false };
  }
  const hasActive = state.abortControllers.size > 0;
  const aborted = hasActive ? Array.from(state.abortControllers)[0].signal.aborted : false;
  return {
    active: state.active,
    hasActiveAbortController: hasActive,
    aborted,
  };
}
