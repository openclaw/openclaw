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
  draining: boolean;
  generation: number;
};

/**
 * Lazy concurrency resolver for lanes that need dynamic initialization.
 * Called on first use if the lane hasn't been explicitly configured.
 */
type LazyConcurrencyResolver = () => Promise<number>;

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

const queueState = resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
  gatewayDraining: false,
  lanes: new Map<string, LaneState>(),
  nextTaskId: 1,
  /** Lazy resolvers for lanes that need dynamic concurrency initialization */
  lazyResolvers: new Map<string, LazyConcurrencyResolver>(),
}));

function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}

function getLaneDepth(state: LaneState): number {
  return state.queue.length + state.activeTaskIds.size;
}

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
    draining: false,
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
async function ensureLaneConcurrency(lane: string): Promise<void> {
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
      const taskId = queueState.nextTaskId++;
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

/**
 * Enqueue a task on a specific command lane. Returns a promise that resolves when the
 * task executes. The lane serializes execution up to its configured concurrency.
 *
 * @param lane - The lane name (e.g., "main", "cron", "nested")
 * @param task - The async task to execute
 * @param opts.warnAfterMs - Log a warning if the task waits longer than this
 * @param opts.onWait - Callback when task is waiting (waitMs, queuedAhead)
 * @returns Promise that resolves with the task result
 */
export function markGatewayDraining(): void {
  queueState.gatewayDraining = true;
}

export async function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: { warnAfterMs?: number; onWait?: (waitMs: number, queuedAhead: number) => void },
): Promise<T> {
  if (queueState.gatewayDraining) {
    throw new GatewayDrainingError();
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
    logLaneEnqueue(cleaned, getLaneDepth(state));
    drainLane(cleaned);
  });
}

/**
 * Enqueue a task on the main command lane. Returns a promise that resolves when the
 * task executes. The main lane serializes execution.
 *
 * @param task - The async task to execute
 * @param opts.warnAfterMs - Log a warning if the task waits longer than this
 * @param opts.onWait - Callback when task is waiting (waitMs, queuedAhead)
 * @returns Promise that resolves with the task result
 */
export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: { warnAfterMs?: number; onWait?: (waitMs: number, queuedAhead: number) => void },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = normalizeLane(lane);
  const state = queueState.lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return getLaneDepth(state);
}

/**
 * Set the maximum concurrency for a lane. This should be called during
 * gateway initialization for lanes that need specific concurrency limits.
 *
 * Note: If a lane has already been lazy-initialized, this will override
 * the lazy value. Explicit configuration always takes precedence.
 *
 * @param lane - The lane name
 * @param maxConcurrent - Maximum number of concurrent tasks (>= 1)
 */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, maxConcurrent);
  drainLane(lane);
}

/**
 * Clear all pending tasks from a lane and reject their promises.
 * Active tasks are allowed to complete.
 *
 * @param lane - The lane to clear
 */
export function clearCommandLane(lane: string = CommandLane.Main): void {
  const state = getLaneState(lane);
  state.generation++;
  const toReject = state.queue.splice(0, state.queue.length);
  for (const entry of toReject) {
    entry.reject(new CommandLaneClearedError(lane));
  }
}

/**
 * Get the total number of queued tasks across all lanes.
 */
export function getTotalQueueSize(): number {
  let total = 0;
  for (const state of queueState.lanes.values()) {
    total += state.queue.length;
  }
  return total;
}

/**
 * Set the gateway draining flag. When true, new tasks will be rejected.
 */
export function setGatewayDraining(draining: boolean): void {
  queueState.gatewayDraining = draining;
}

/**
 * Check if the gateway is currently draining.
 */
export function isGatewayDraining(): boolean {
  return queueState.gatewayDraining;
}

export function resetAllLanes(): void {
  queueState.gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const state of queueState.lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  // Drain after the full reset pass so all lanes are in a clean state first.
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
}

/**
 * Returns the total number of actively executing tasks across all lanes
 * (excludes queued-but-not-started entries).
 */
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
 *
 * New tasks enqueued after this call are ignored — only tasks that are
 * already executing are waited on.
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
  // Keep shutdown/drain checks responsive without busy looping.
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

      let hasPending = false;
      for (const state of queueState.lanes.values()) {
        for (const taskId of state.activeTaskIds) {
          if (activeAtStart.has(taskId)) {
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
