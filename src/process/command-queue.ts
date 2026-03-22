import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";
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

// Set while gateway is draining for restart; new enqueues are rejected.
let gatewayDraining = false;

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
  draining: boolean;
  generation: number;
};

const lanes = new Map<string, LaneState>();
let nextTaskId = 1;

/**
 * Lazy concurrency resolver for lanes that need dynamic initialization.
 * Called on first use if the lane hasn't been explicitly configured.
 */
type LazyConcurrencyResolver = () => Promise<number>;
const lazyResolvers = new Map<string, LazyConcurrencyResolver>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  };
  lanes.set(lane, created);
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
  lazyResolvers.set(lane, resolver);
}

/**
 * Ensure a lane's concurrency is initialized.
 * If the lane was explicitly configured (maxConcurrent != 1), this is a no-op.
 * If a lazy resolver is registered, it will be called and the result applied.
 */
async function ensureLaneConcurrency(lane: string): Promise<void> {
  const state = getLaneState(lane);

  // If already configured (not default), skip
  if (state.maxConcurrent !== 1) {
    return;
  }

  // Check if we have a lazy resolver
  const resolver = lazyResolvers.get(lane);
  if (!resolver) {
    return;
  }

  // Resolve and apply concurrency
  try {
    const maxConcurrent = await resolver();
    state.maxConcurrent = Math.max(1, maxConcurrent);
    diag.debug(`Lazy-initialized lane "${lane}" with maxConcurrent: ${state.maxConcurrent}`);
  } catch (err) {
    diag.warn(`Failed to lazy-initialize lane "${lane}": ${String(err)}`);
    // Keep default maxConcurrent: 1 on failure
  }
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
  if (state.draining) {
    if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return;
  }
  state.draining = true;

  const pump = () => {
    try {
      if (state.activeTaskIds.size >= state.maxConcurrent) {
        return;
      }
      const entry = state.queue.shift();
      if (!entry) {
        if (state.activeTaskIds.size === 0) {
          state.draining = false;
        }
        return;
      }
      const taskId = nextTaskId++;
      const taskGeneration = state.generation;
      state.activeTaskIds.add(taskId);
      void entry
        .task()
        .then(
          (value) => {
            entry.resolve(value);
          },
          (reason) => {
            entry.reject(reason);
          },
        )
        .finally(() => {
          completeTask(state, taskId, taskGeneration);
          pump();
        });
      pump();
    } catch (err) {
      diag.error(`drainLane pump error: lane=${lane} err=${String(err)}`);
    }
  };
  pump();
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

export async function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  if (gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = lane.trim() || CommandLane.Main;

  // Ensure lane concurrency is initialized (supports lazy loading)
  await ensureLaneConcurrency(cleaned);

  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, state.queue.length + state.activeTaskIds.size);
    drainLane(cleaned);
  });
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
  const state = lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return state.queue.length + state.activeTaskIds.size;
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.queue.length + s.activeTaskIds.size;
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
  gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const state of lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
}

export function markGatewayDraining(): void {
  gatewayDraining = true;
}

export function setGatewayDraining(draining: boolean): void {
  gatewayDraining = draining;
}

export function isGatewayDraining(): boolean {
  return gatewayDraining;
}

export function getActiveTaskCount(): number {
  let total = 0;
  for (const s of lanes.values()) {
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
  for (const state of lanes.values()) {
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
      if (Date.now() >= deadline) {
        resolve({ drained: false });
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}
