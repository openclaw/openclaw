import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";
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

function isExpectedNonErrorLaneFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "LiveSessionModelSwitchError";
}

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

function getQueueState() {
  return resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
    gatewayDraining: false,
    lanes: new Map<string, LaneState>(),
    nextTaskId: 1,
    /** Lazy resolvers for lanes that need dynamic concurrency initialization */
    lazyResolvers: new Map<string, LazyConcurrencyResolver>(),
  }));
}

function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}

function getLaneDepth(state: LaneState): number {
  return state.queue.length + state.activeTaskIds.size;
}

function getLaneState(lane: string): LaneState {
  const state = getQueueState();
  const existing = state.lanes.get(lane);
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
  state.lanes.set(lane, created);
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
  getQueueState().lazyResolvers.set(lane, resolver);
}

/**
 * Ensure a lane's concurrency is initialized.
 * If the lane was explicitly configured (maxConcurrent != 1), this is a no-op.
 * If a lazy resolver is registered, it will be called and the result applied.
 */
async function ensureLaneConcurrency(lane: string): Promise<void> {
  const state = getLaneState(lane);

  // Check if we have a lazy resolver — always run it on first call to initialize
  const resolver = getQueueState().lazyResolvers.get(lane);
  if (!resolver) {
    // No lazy resolver; nothing to do unless someone explicitly configured the lane
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
  try {
    const pump = () => {
      try {
        while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
          const entry = state.queue.shift() as QueueEntry;
          const waitedMs = Date.now() - entry.enqueuedAt;
          if (waitedMs >= entry.warnAfterMs) {
            try {
              entry.onWait?.(waitedMs, state.queue.length);
            } catch (err) {
              diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
            }
            diag.warn(
              `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${state.queue.length}`,
            );
          }
          logLaneDequeue(lane, waitedMs, state.queue.length);
          const taskId = getQueueState().nextTaskId++;
          const taskGeneration = state.generation;
          state.activeTaskIds.add(taskId);
          const startTime = Date.now();
          void (async () => {
            try {
              const result = await entry.task();
              const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
              if (completedCurrentGeneration) {
                diag.debug(
                  `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
                );
                pump();
              }
              entry.resolve(result);
            } catch (err) {
              const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
              const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
              if (!isProbeLane && !isExpectedNonErrorLaneFailure(err)) {
                diag.error(
                  `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
                );
              } else if (!isProbeLane) {
                diag.debug(
                  `lane task interrupted: lane=${lane} durationMs=${Date.now() - startTime} reason="${String(err)}"`,
                );
              }
              if (completedCurrentGeneration) {
                pump();
              }
              entry.reject(err);
            }
          })();
        }
      } catch (err) {
        diag.error(`drainLane pump error: lane=${lane} err=${String(err)}`);
      }
    };
    pump();
  } finally {
    state.draining = false;
  }
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
  getQueueState().gatewayDraining = true;
}

export async function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: { warnAfterMs?: number; onWait?: (waitMs: number, queuedAhead: number) => void },
): Promise<T> {
  const state = getQueueState();
  if (state.gatewayDraining) {
    throw new GatewayDrainingError();
  }

  const cleaned = lane.trim() || CommandLane.Main;

  // Ensure lane concurrency is initialized (supports lazy loading)
  await ensureLaneConcurrency(cleaned);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const laneState = getLaneState(cleaned);

  return new Promise<T>((resolve, reject) => {
    laneState.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, getLaneDepth(laneState));
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
  const state = getQueueState().lanes.get(resolved);
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
  for (const s of getQueueState().lanes.values()) {
    total += getLaneDepth(s);
  }
  return total;
}

/**
 * Set the gateway draining flag. When true, new tasks will be rejected.
 */
export function setGatewayDraining(draining: boolean): void {
  getQueueState().gatewayDraining = draining;
}

/**
 * Test-only hard reset that discards all queue state, including preserved
 * queued work from previous generations. Use this when a suite needs an
 * isolated baseline across shared-worker runs.
 */
export function resetCommandQueueStateForTest(): void {
  const queueState = getQueueState();
  queueState.gatewayDraining = false;
  queueState.lanes.clear();
  queueState.nextTaskId = 1;
}

/**
 * Check if the gateway is currently draining.
 */
export function isGatewayDraining(): boolean {
  return getQueueState().gatewayDraining;
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
  const state = getQueueState();
  state.gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const s of state.lanes.values()) {
    s.generation += 1;
    s.activeTaskIds.clear();
    s.draining = false;
    if (s.queue.length > 0) {
      lanesToDrain.push(s.lane);
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
  const state = getQueueState();
  let total = 0;
  for (const s of state.lanes.values()) {
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
  const state = getQueueState();
  const activeAtStart = new Set<number>();
  for (const s of state.lanes.values()) {
    for (const taskId of s.activeTaskIds) {
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
      for (const s of state.lanes.values()) {
        for (const taskId of s.activeTaskIds) {
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
