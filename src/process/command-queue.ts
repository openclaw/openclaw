import { diagnosticLogger as diag, logLaneEnqueue } from "../logging/diagnostic.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CommandLane } from "./lanes.js";

/**
 * Dedicated error type thrown when a queued command is rejected because
 * its lane was cleared.  Callers that fire-and-forget enqueued tasks can
 * catch (or ignore) this specific type to avoid unhandled-rejection noise.
 */
export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

/**
 * Dedicated error type thrown when a new command is rejected because the
 * gateway is currently draining for restart.
 */
export class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is draining for restart; new tasks are not accepted");
    this.name = "GatewayDrainingError";
  }
}

// Minimal in-process queue to serialize command executions.
// Default lane ("main") preserves the existing behavior. Additional lanes allow
// low-risk parallelism (e.g. cron jobs) without interleaving stdin / logs for
// the main auto-reply workflow.

type QueueEntry = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  generation: number;
};

/** Lazy concurrency resolver for lanes that need dynamic initialization */
type LazyConcurrencyResolver = () => Promise<number>;

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

const queueState = resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
  gatewayDraining: false as boolean,
  lanes: new Map<string, LaneState>(),
  nextTaskId: 1 as number,
  /** Lazy resolvers for lanes that need dynamic concurrency initialization */
  lazyResolvers: new Map<string, LazyConcurrencyResolver>(),
}));

function getLaneState(lane: string): LaneState {
  const existing = queueState.lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    maxConcurrent: 1,
    generation: 0,
  };
  queueState.lanes.set(lane, created);
  return created;
}

/**
 * Register a lazy concurrency resolver for a lane.
 * The resolver will be called on first use of the lane if it hasn't been
 * explicitly configured via setCommandLaneConcurrency().
 *
 * This allows lanes to be initialized on-demand without adding startup cost.
 */
export function registerLazyLaneConcurrency(lane: string, resolver: LazyConcurrencyResolver): void {
  queueState.lazyResolvers.set(lane, resolver);
}

/**
 * Ensure a lane's concurrency is initialized.
 * If the lane was explicitly configured (maxConcurrent != 1), this is a no-op.
 * If a lazy resolver is registered, it will be called and the result applied.
 */
function ensureLaneConcurrency(lane: string): void | Promise<void> {
  const state = getLaneState(lane);

  // If already configured (not default), skip
  if (state.maxConcurrent !== 1) {
    return;
  }

  // Check if we have a lazy resolver
  const resolver = queueState.lazyResolvers.get(lane);
  if (!resolver) {
    return;
  }

  // Resolve and apply concurrency
  return (async () => {
    try {
      const maxConcurrent = await resolver();
      state.maxConcurrent = Math.max(1, maxConcurrent);
      diag.debug(`Lazy-initialized lane "${lane}" with maxConcurrent: ${state.maxConcurrent}`);
    } catch (err) {
      diag.warn(`Failed to lazy-initialize lane "${lane}": ${String(err)}`);
      // Keep default maxConcurrent: 1 on failure
    }
  })();
}

function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
  if (taskGeneration !== state.generation) {
    return false;
  }
  state.activeTaskIds.delete(taskId);
  return true;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);

  // Fill available concurrency slots from the queue.
  while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
    const entry = state.queue.shift()!;
    const taskId = queueState.nextTaskId++;
    const taskGeneration = state.generation;
    state.activeTaskIds.add(taskId);

    // Track wait time and invoke onWait if threshold exceeded
    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs >= entry.warnAfterMs && entry.onWait) {
      try {
        entry.onWait(waitMs, state.queue.length);
      } catch (err) {
        diag.error(`onWait callback error in lane "${lane}": ${String(err)}`);
      }
    }

    void entry.task().then(
      (val) => {
        const wasActive = completeTask(state, taskId, taskGeneration);
        entry.resolve(val);
        // If we successfully updated state, try to fill the now-free slot.
        if (wasActive) {
          drainLane(lane);
        }
      },
      (err) => {
        const wasActive = completeTask(state, taskId, taskGeneration);
        entry.reject(err);
        if (wasActive) {
          drainLane(lane);
        }
      },
    );
  }
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  if (queueState.gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;

  // We must push to the queue SYNCHRONOUSLY to ensure immediate visibility
  // to subsequent status checks (getActiveTaskCount, getQueueSize, etc).
  const taskPromise = new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, state.queue.length + state.activeTaskIds.size);
  });

  // Now ensure lane concurrency is initialized and then trigger draining.
  // For most lanes (including "main"), this will be synchronous or near-instant.
  const init = ensureLaneConcurrency(cleaned);
  if (init && typeof init === "object" && "then" in init) {
    // Lazy initialization in progress; wait for it before draining.
    void init.then(() => drainLane(cleaned));
  } else {
    // Already initialized or no resolver; drain immediately.
    drainLane(cleaned);
  }

  return taskPromise;
}

export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = lane.trim() || CommandLane.Main;
  const state = queueState.lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return state.queue.length + state.activeTaskIds.size;
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of queueState.lanes.values()) {
    total += s.queue.length + s.activeTaskIds.size;
  }
  return total;
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = queueState.lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new CommandLaneClearedError(cleaned));
  }
  return removed;
}

/**
 * Reset all lane runtime state to idle. Used after SIGUSR1 in-process
 * restarts where interrupted tasks' finally blocks may not run, leaving
 * stale active task IDs that permanently block new work from draining.
 *
 * Bumps lane generation and clears execution counters so stale completions
 * from old in-flight tasks are ignored. Queued entries are intentionally
 * preserved — they represent pending user work that should still execute
 * after restart.
 *
 * After resetting, drains any lanes that still have queued entries so
 * preserved work is pumped immediately rather than waiting for a future
 * `enqueueCommandInLane()` call (which may never come).
 */
export function resetAllLanes(): void {
  queueState.gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const state of queueState.lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
}

export function markGatewayDraining(): void {
  queueState.gatewayDraining = true;
}

export function setGatewayDraining(draining: boolean): void {
  queueState.gatewayDraining = draining;
}

export function isGatewayDraining(): boolean {
  return queueState.gatewayDraining;
}

export function getActiveTaskCount(): number {
  let total = 0;
  for (const s of queueState.lanes.values()) {
    total += s.activeTaskIds.size;
  }
  return total;
}

/**
 * Wait for all currently active tasks across all lanes to finish.
 * Polls at a short interval; resolves when no tasks are active or
 * when `timeoutMs` elapses (whichever comes first).
 */
export async function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
  const POLL_INTERVAL_MS = 50;
  const deadline = Date.now() + timeoutMs;
  const activeAtStart = new Set<number>();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      activeAtStart.add(taskId);
    }
  }

  return new Promise((resolve) => {
    const check = () => {
      if (activeAtStart.size === 0) {
        resolve({ drained: true });
        return;
      }

      // Check if any task from the snapshot is still running
      let hasPending = false;
      for (const taskId of activeAtStart) {
        // A task is pending if its ID is still in any lane's activeTaskIds
        for (const state of queueState.lanes.values()) {
          if (state.activeTaskIds.has(taskId)) {
            hasPending = true;
            break;
          }
        }
        if (hasPending) {
          break;
        }
      }

      if (!hasPending) {
        resolve({ drained: true });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ drained: false });
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}
