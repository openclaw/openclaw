import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";
import { CommandLane } from "./lanes.js";
import { queueBackend } from "./queue-backend.js";

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

type LaneState = {
  lane: string;
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

export type TaskHandler<T = any> = (payload: T) => Promise<unknown>;

const handlers = new Map<string, TaskHandler>();

export function registerCommandHandler<T>(taskType: string, handler: TaskHandler<T>) {
  if (handlers.has(taskType)) {
    diag.warn(`Command handler for task type "${taskType}" is being overwritten.`);
  }
  handlers.set(taskType, handler);
}

type ResolverEntry = {
  resolve: (val: unknown) => void;
  reject: (err: unknown) => void;
  warnAfterMs: number;
  enqueuedAt: number;
  lane: string;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  executeFn?: () => Promise<unknown>;
};

const memoryResolvers = new Map<number, ResolverEntry>();

const lanes = new Map<string, LaneState>();
let nextMemoryTaskId = 1;

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    activeTaskIds: new Set(),
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  };
  lanes.set(lane, created);
  return created;
}

function completeTask(state: LaneState, memTaskId: number, taskGeneration: number): boolean {
  if (taskGeneration !== state.generation) {
    return false;
  }
  state.activeTaskIds.delete(memTaskId);
  return true;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    return;
  }
  state.draining = true;
  const backend = queueBackend();

  const pump = () => {
    try {
      while (state.activeTaskIds.size < state.maxConcurrent) {
        const dbTask = backend.claimNextPendingTask(lane);
        if (!dbTask) {
          break;
        }

        const memTaskId = nextMemoryTaskId++;
        const taskGeneration = state.generation;
        state.activeTaskIds.add(memTaskId);

        const qAhead = backend.countQueueByStatus(lane, "PENDING");
        const resolvers = memoryResolvers.get(dbTask.id);

        if (resolvers) {
          const waitedMs = Date.now() - resolvers.enqueuedAt;
          if (waitedMs >= resolvers.warnAfterMs) {
            resolvers.onWait?.(waitedMs, qAhead);
            diag.warn(`lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${qAhead}`);
          }
          logLaneDequeue(lane, waitedMs, qAhead);
        } else {
          logLaneDequeue(lane, Date.now() - dbTask.created_at, qAhead);
        }

        void (async () => {
          const startTime = Date.now();
          try {
            let result: unknown;
            if (resolvers?.executeFn) {
              result = await resolvers.executeFn();
            } else {
              const handler = handlers.get(dbTask.task_type);
              if (!handler) {
                throw new Error(`No handler registered for task type: ${dbTask.task_type}`);
              }
              const parsedPayload = JSON.parse(dbTask.payload);
              result = await handler(parsedPayload);
            }

            backend.resolveTask(dbTask.id, result);

            const completedCurrentGeneration = completeTask(state, memTaskId, taskGeneration);
            if (completedCurrentGeneration) {
              diag.debug(
                `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${qAhead}`,
              );
              pump();
            }

            if (resolvers) {
              resolvers.resolve(result);
              memoryResolvers.delete(dbTask.id);
            }
          } catch (err) {
            backend.rejectTask(dbTask.id, String(err));

            const completedCurrentGeneration = completeTask(state, memTaskId, taskGeneration);
            const isProbeLane =
              lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
            if (!isProbeLane) {
              diag.error(
                `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
              );
            }
            if (completedCurrentGeneration) {
              pump();
            }

            if (resolvers) {
              resolvers.reject(err);
              memoryResolvers.delete(dbTask.id);
            }
          }
        })();
      }
    } finally {
      state.draining = false;
    }
  };

  pump();
}

/**
 * Mark gateway as draining for restart so new enqueues fail fast with
 * `GatewayDrainingError` instead of being silently killed on shutdown.
 */
export function markGatewayDraining(): void {
  gatewayDraining = true;
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

export function enqueueCommandInLane<T>(
  lane: string,
  taskType: string,
  payload: any,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
    executeFn?: () => Promise<T>;
  },
): Promise<T> {
  if (gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = lane.trim() || CommandLane.Main;
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const backend = queueBackend();

  const dbId = backend.insertTask(cleaned, taskType, payload);

  return new Promise<T>((resolve, reject) => {
    memoryResolvers.set(dbId, {
      resolve: (val) => resolve(val as T),
      reject,
      warnAfterMs,
      enqueuedAt: Date.now(),
      lane: cleaned,
      onWait: opts?.onWait,
      executeFn: opts?.executeFn as (() => Promise<unknown>) | undefined,
    });

    const qSize = backend.countQueueByStatus(cleaned);
    logLaneEnqueue(cleaned, qSize);
    drainLane(cleaned);
  });
}

export function enqueueCommand<T>(
  taskType: string,
  payload: any,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, taskType, payload, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = lane.trim() || CommandLane.Main;
  return queueBackend().countQueueByStatus(resolved);
}

export function getTotalQueueSize() {
  return queueBackend().countTotalQueue();
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = lane.trim() || CommandLane.Main;
  const backend = queueBackend();

  const pendingIds = backend.getPendingTaskIdsForLane(cleaned);
  const removedCount = backend.clearLaneTasks(cleaned);

  const clearError = new CommandLaneClearedError(cleaned);
  for (const dbId of pendingIds) {
    const entry = memoryResolvers.get(dbId);
    if (entry) {
      entry.reject(clearError);
      memoryResolvers.delete(dbId);
    }
  }

  return removedCount;
}

export function scheduleLaneDrainByName(lane: string): void {
  getLaneState(lane);
  drainLane(lane);
}

export function resetAllLanes(): void {
  gatewayDraining = false;
  const backend = queueBackend();
  const affectedLanes = backend.recoverRunningTasks();
  const pendingLanes = backend.getPendingLanes();

  const lanesToDrain: string[] = Array.from(
    new Set([...affectedLanes, ...pendingLanes, ...Array.from(lanes.keys())]),
  );

  for (const state of lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
  }

  for (const lane of lanesToDrain) {
    getLaneState(lane);
    drainLane(lane);
  }
}

export function getActiveTaskCount(): number {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.activeTaskIds.size;
  }
  return total;
}

/**
 * Wait for currently-active tasks to finish. New tasks enqueued after
 * this call are ignored — only the tasks running at the moment of the
 * call are tracked.
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
  const POLL_INTERVAL_MS = 50;
  const deadline = Date.now() + timeoutMs;

  const snapshot = new Set<number>();
  for (const state of lanes.values()) {
    for (const id of state.activeTaskIds) {
      snapshot.add(id);
    }
  }

  return new Promise((resolve) => {
    if (snapshot.size === 0) {
      resolve({ drained: true });
      return;
    }
    const check = () => {
      let anyStillActive = false;
      for (const state of lanes.values()) {
        for (const id of snapshot) {
          if (state.activeTaskIds.has(id)) {
            anyStillActive = true;
            break;
          }
        }
        if (anyStillActive) {
          break;
        }
      }
      if (!anyStillActive) {
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

/**
 * Reset all in-memory state (handlers, resolvers, lanes). Test-only.
 */
export function _resetForTests(): void {
  handlers.clear();
  memoryResolvers.clear();
  lanes.clear();
  nextMemoryTaskId = 1;
  gatewayDraining = false;
}
