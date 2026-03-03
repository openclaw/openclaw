import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";
/**
 * Dedicated error type thrown when a queued command is rejected because
 * its lane was cleared.  Callers that fire-and-forget enqueued tasks can
 * catch (or ignore) this specific type to avoid unhandled-rejection noise.
 */
export class CommandLaneClearedError extends Error {
    constructor(lane) {
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
const lanes = new Map();
let nextTaskId = 1;
function getLaneState(lane) {
    const existing = lanes.get(lane);
    if (existing) {
        return existing;
    }
    const created = {
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
function completeTask(state, taskId, taskGeneration) {
    if (taskGeneration !== state.generation) {
        return false;
    }
    state.activeTaskIds.delete(taskId);
    return true;
}
function drainLane(lane) {
    const state = getLaneState(lane);
    if (state.draining) {
        if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
            diag.warn(`drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`);
        }
        return;
    }
    state.draining = true;
    const pump = () => {
        try {
            while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
                const entry = state.queue.shift();
                const waitedMs = Date.now() - entry.enqueuedAt;
                if (waitedMs >= entry.warnAfterMs) {
                    try {
                        entry.onWait?.(waitedMs, state.queue.length);
                    }
                    catch (err) {
                        diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
                    }
                    diag.warn(`lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${state.queue.length}`);
                }
                logLaneDequeue(lane, waitedMs, state.queue.length);
                const taskId = nextTaskId++;
                const taskGeneration = state.generation;
                state.activeTaskIds.add(taskId);
                void (async () => {
                    const startTime = Date.now();
                    try {
                        const result = await entry.task();
                        const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
                        if (completedCurrentGeneration) {
                            diag.debug(`lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`);
                            pump();
                        }
                        entry.resolve(result);
                    }
                    catch (err) {
                        const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
                        const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
                        if (!isProbeLane) {
                            diag.error(`lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`);
                        }
                        if (completedCurrentGeneration) {
                            pump();
                        }
                        entry.reject(err);
                    }
                })();
            }
        }
        finally {
            state.draining = false;
        }
    };
    pump();
}
/**
 * Mark gateway as draining for restart so new enqueues fail fast with
 * `GatewayDrainingError` instead of being silently killed on shutdown.
 */
export function markGatewayDraining() {
    gatewayDraining = true;
}
export function setCommandLaneConcurrency(lane, maxConcurrent) {
    const cleaned = lane.trim() || "main" /* CommandLane.Main */;
    const state = getLaneState(cleaned);
    state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    drainLane(cleaned);
}
export function enqueueCommandInLane(lane, task, opts) {
    if (gatewayDraining) {
        return Promise.reject(new GatewayDrainingError());
    }
    const cleaned = lane.trim() || "main" /* CommandLane.Main */;
    const warnAfterMs = opts?.warnAfterMs ?? 2000;
    const state = getLaneState(cleaned);
    return new Promise((resolve, reject) => {
        state.queue.push({
            task: () => task(),
            resolve: (value) => resolve(value),
            reject,
            enqueuedAt: Date.now(),
            warnAfterMs,
            onWait: opts?.onWait,
        });
        logLaneEnqueue(cleaned, state.queue.length + state.activeTaskIds.size);
        drainLane(cleaned);
    });
}
export function enqueueCommand(task, opts) {
    return enqueueCommandInLane("main" /* CommandLane.Main */, task, opts);
}
export function getQueueSize(lane = "main" /* CommandLane.Main */) {
    const resolved = lane.trim() || "main" /* CommandLane.Main */;
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
export function clearCommandLane(lane = "main" /* CommandLane.Main */) {
    const cleaned = lane.trim() || "main" /* CommandLane.Main */;
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
export function resetAllLanes() {
    gatewayDraining = false;
    const lanesToDrain = [];
    for (const state of lanes.values()) {
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
export function getActiveTaskCount() {
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
 *
 * New tasks enqueued after this call are ignored — only tasks that are
 * already executing are waited on.
 */
export function waitForActiveTasks(timeoutMs) {
    // Keep shutdown/drain checks responsive without busy looping.
    const POLL_INTERVAL_MS = 50;
    const deadline = Date.now() + timeoutMs;
    const activeAtStart = new Set();
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
            let hasPending = false;
            for (const state of lanes.values()) {
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
