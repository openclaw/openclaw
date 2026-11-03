import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage, readErrorName, toErrorObject } from "../infra/errors.js";
import {
  diagnosticLogger as diag,
  logLaneDequeue,
  logLaneEnqueue,
} from "../logging/diagnostic-runtime.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  applyCommandLaneCapacity,
  canAdmitInGroup,
  type CommandLaneGroupSpec,
  drainCommandLaneGroup,
  getLaneGroup,
  installCommandLaneGroup,
  validateCommandLaneGroupSpec,
} from "./command-queue.capacity-groups.js";
import {
  dequeueLaneQueue,
  enqueueLaneQueue,
  getDefaultLaneConcurrency,
  getLaneState,
  getQueueState,
  type LaneState,
  normalizeLane,
  removeLaneQueueEntry,
  type QueueEntry,
  type QueuePriority,
} from "./command-queue.state.js";
import type { CommandLaneSnapshot, CommandQueueAdmissionOptions } from "./command-queue.types.js";
import { isExpectedRunCancellation } from "./expected-run-cancellation.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkReadmission,
} from "./gateway-work-admission.js";
import { CommandLane, SUBAGENT_LANE_PREFIX, SWARM_LANE_PREFIX } from "./lanes.js";
export {
  GatewayDrainingError,
  isGatewayWorkAdmissionClosed as isGatewayDraining,
  markGatewayRestartDraining as markGatewayDraining,
} from "./gateway-work-admission.js";
export type { CommandLaneSnapshot } from "./command-queue.types.js";
/** Controller-owned timeout; queue capacity remains held until raw task settlement. */
export class CommandLaneTaskTimeoutError extends Error {
  constructor(
    lane: string,
    details:
      | { cause: "owner-deadline"; elapsedMs: number; taskBudgetMs: number }
      | { cause: "abort-grace"; elapsedMs: number; graceMs: number; taskBudgetMs: number }
      | { cause: "release-signal"; elapsedMs: number; taskBudgetMs: number },
  ) {
    const message = (() => {
      switch (details.cause) {
        case "owner-deadline":
          return `owner deadline reached after ${details.elapsedMs}ms`;
        case "abort-grace":
          return `abort grace ${details.graceMs}ms elapsed (task budget ${details.taskBudgetMs}ms, elapsed ${details.elapsedMs}ms)`;
        case "release-signal":
          return `lane release requested after ${details.elapsedMs}ms (task budget ${details.taskBudgetMs}ms)`;
        default:
          throw new TypeError("Unsupported command lane timeout cause");
      }
    })();
    super(`Command lane "${lane}" task timed out: ${message}`);
    this.name = "CommandLaneTaskTimeoutError";
  }
}

export function isCommandLaneTaskTimeoutError(err: unknown, lane?: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (!(err instanceof CommandLaneTaskTimeoutError || err.name === "CommandLaneTaskTimeoutError")) {
    return false;
  }
  return lane === undefined || err.message.includes(`Command lane "${lane}" task timed out`);
}

function isExpectedNonErrorLaneFailure(err: unknown): boolean {
  return (
    (err instanceof Error &&
      (err.name === "LiveSessionModelSwitchError" ||
        err.name === "MemoryFlushToolsUnavailableError")) ||
    isExpectedRunCancellation(err)
  );
}

function isQuietProbeLane(lane: string): boolean {
  // setup-inference.ts retains its temp session key, so its derived session lane
  // needs the same expected-failure treatment as the explicit probe lane.
  return (
    lane.startsWith("auth-probe:") ||
    lane.startsWith("session:probe-") ||
    lane.startsWith("session:temp:setup-inference:probe-setup-inference-")
  );
}

function getLaneDepth(state: LaneState): number {
  return state.queue.length + state.activeTasks.size;
}

function retireIdleScopedCommandLane(state: LaneState): void {
  if (
    state.draining ||
    state.activeTasks.size > 0 ||
    state.queue.length > 0 ||
    (!state.lane.startsWith(SUBAGENT_LANE_PREFIX) &&
      (state.maxConcurrent !== 1 ||
        // Setup-probe lanes bound setup concurrency; they do not order session turns.
        (!state.lane.startsWith("session:probe-") &&
          !state.lane.startsWith("nested:") &&
          !state.lane.startsWith("cli:") &&
          !state.lane.startsWith("context-engine-turn-maintenance:"))))
  ) {
    return;
  }

  const lanes = getQueueState().lanes;
  // A completed generation may race a recreated lane. Only retire the exact
  // idle scoped state after its pump has released the draining guard.
  if (lanes.get(state.lane) === state) {
    lanes.delete(state.lane);
  }
}

function resolveQueuePriority(priority: CommandQueueAdmissionOptions["priority"]): QueuePriority {
  switch (priority) {
    case "foreground":
      return 1;
    case "background":
      return -1;
    default:
      return 0;
  }
}

function drainLane(
  lane: string,
  maxStarts = Number.POSITIVE_INFINITY,
  state = getLaneState(lane),
): number {
  if (state.draining) {
    if (state.activeTasks.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return 0;
  }
  state.draining = true;
  let started = 0;
  try {
    while (
      started < maxStarts &&
      state.activeTasks.size < state.maxConcurrent &&
      state.queue.length > 0 &&
      canAdmitInGroup(lane)
    ) {
      const entry = dequeueLaneQueue(state.queue) as QueueEntry;
      const waitedMs = Math.floor(performance.now()) - entry.enqueuedAt;
      const activeBeforeStart = state.activeTasks.size;
      const taskId = getQueueState().nextTaskId++;
      const taskGeneration = state.generation;
      // Commit the admission before invoking callbacks or logging. Both can
      // synchronously re-enter the queue, and the shared budget must already
      // account for this task when that nested admission is evaluated.
      state.activeTasks.set(taskId, entry.sessionTarget);
      started += 1;
      const startTime = Date.now();
      void (async () => {
        try {
          if (waitedMs >= entry.warnAfterMs) {
            try {
              entry.onWait?.(waitedMs, entry.queuedAheadAtEnqueue);
            } catch (err) {
              diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
            }
            diag.warn(
              `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${entry.queuedAheadAtEnqueue} ` +
                `activeAhead=${entry.activeAheadAtEnqueue} activeNow=${activeBeforeStart} queueBehind=${state.queue.length}`,
              entry.taskIdentity,
            );
          }
          logLaneDequeue(lane, waitedMs, state.queue.length);
          return await Promise.resolve().then(() => entry.task());
        } finally {
          // Admission diagnostics and task cleanup can throw too. Release and
          // pump exactly once, without letting an old generation free new work.
          if (taskGeneration === state.generation) {
            state.activeTasks.delete(taskId);
            drainReadyCommandLane(lane, state);
          }
        }
      })()
        .then(
          (result) => {
            entry.resolve(result);
          },
          (err: unknown) => {
            entry.reject(err);
            const quietFailure =
              isQuietProbeLane(lane) ||
              (entry.taskIdentity?.modelFallbackCandidate &&
                readErrorName(err) === "FailoverError");
            if (!quietFailure && !isExpectedNonErrorLaneFailure(err)) {
              diag.error(
                `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error=${JSON.stringify(formatErrorMessage(err))}`,
                { errorName: readErrorName(err) || undefined, ...entry.taskIdentity },
              );
            } else if (!quietFailure) {
              diag.debug(
                `lane task interrupted: lane=${lane} durationMs=${Date.now() - startTime} reason="${String(err)}"`,
              );
            }
          },
        )
        .catch(() => {
          try {
            diag.warn(
              `lane task diagnostics failed after settlement: lane=${lane} taskId=${taskId} generation=${taskGeneration}`,
              entry.taskIdentity,
            );
          } catch {
            // A broken diagnostic sink cannot undo settlement or stop the pump.
          }
        });
    }
  } finally {
    state.draining = false;
    retireIdleScopedCommandLane(state);
  }
  return started;
}

function drainReadyCommandLane(lane: string, completedState?: LaneState): void {
  runInDetachedAsyncContext(() => {
    if (getLaneGroup(lane)) {
      drainCommandLaneGroup(lane, drainLane);
      return;
    }
    // An older completion must not retire a recreated lane that it never owned.
    drainLane(lane, Number.POSITIVE_INFINITY, completedState);
  });
}

function updateLaneConcurrency(lane: string, maxConcurrent: number): LaneState[] {
  const state = getLaneState(lane);
  const minConcurrent = isQuietProbeLane(lane) ? 1 : 0;
  state.maxConcurrent = Math.max(minConcurrent, Math.floor(maxConcurrent));
  const updated = [state];
  if (lane === "subagent") {
    // The named lane owns the setting; each spawning session gets its own
    // capacity. Publish every existing queue's new width before admitting work.
    for (const scoped of getQueueState().lanes.values()) {
      if (
        scoped.lane.startsWith(SUBAGENT_LANE_PREFIX) &&
        !scoped.lane.startsWith(SWARM_LANE_PREFIX)
      ) {
        scoped.maxConcurrent = state.maxConcurrent;
        updated.push(scoped);
      }
    }
  }
  return updated;
}

/**
 * Publish lane widths and groups before draining: per-lane setters could admit
 * work before its group budget exists. Grouped callers must use this transaction.
 */
export function publishLaneConfiguration(config: {
  lanes?: Readonly<Record<string, number>>;
  groups?: Readonly<Record<string, CommandLaneGroupSpec>>;
  /** Groups to remove as part of the same transaction. */
  clearGroups?: readonly string[];
}): void {
  // Validate before mutation so a rejected group cannot leave widened lanes behind.
  const validated = Object.entries(config.groups ?? {}).map(([group, spec]) =>
    validateCommandLaneGroupSpec(group, spec),
  );

  const touched = new Set<string>();
  for (const [rawLane, maxConcurrent] of Object.entries(config.lanes ?? {})) {
    const lane = normalizeLane(rawLane);
    for (const state of updateLaneConcurrency(lane, maxConcurrent)) {
      touched.add(state.lane);
    }
  }
  for (const group of config.clearGroups ?? []) {
    const { laneGroups: groups, laneGroupByLane: groupByLane } = getQueueState();
    const existing = groups.get(group);
    if (existing) {
      for (const member of existing.members) {
        groupByLane.delete(member);
        touched.add(member);
      }
      groups.delete(group);
    }
  }
  for (const next of validated) {
    const { laneGroups: groups, laneGroupByLane: groupByLane } = getQueueState();
    const previous = groups.get(next.group);
    for (const member of previous?.members ?? []) {
      touched.add(member);
    }
    for (const member of next.members) {
      const previousOwner = groupByLane.get(member);
      for (const previousSibling of groups.get(previousOwner ?? "")?.members ?? []) {
        touched.add(previousSibling);
      }
    }
    installCommandLaneGroup(next);
    for (const member of next.members) {
      touched.add(member);
    }
  }
  for (const lane of touched) {
    const state = getQueueState().lanes.get(lane);
    if (state && state.maxConcurrent > 0 && state.queue.length > 0 && !state.draining) {
      drainReadyCommandLane(lane);
    }
  }
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = normalizeLane(lane);
  for (const state of updateLaneConcurrency(cleaned, maxConcurrent)) {
    if (state.maxConcurrent > 0) {
      drainReadyCommandLane(state.lane);
    }
  }
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: CommandQueueAdmissionOptions,
): Promise<T> {
  if (opts?.abortSignal?.aborted) {
    return Promise.reject(toErrorObject(opts.abortSignal.reason, "Queued command aborted"));
  }
  const queueState = getQueueState();
  if (isGatewaySubordinateWorkAdmissionClosed()) {
    return Promise.reject(new GatewayDrainingError());
  }
  const runInAsyncContext = AsyncLocalStorage.snapshot();
  const { onWait } = opts ?? {};
  const cleaned = normalizeLane(lane);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  if (opts?.maxConcurrent !== undefined) {
    state.maxConcurrent = Math.max(0, Math.floor(opts.maxConcurrent));
  }
  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      task: () => runInAsyncContext(runWithGatewayRootWorkReadmission, task),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Math.floor(performance.now()),
      sequence: queueState.nextQueueSequence++,
      priority: resolveQueuePriority(opts?.priority),
      warnAfterMs,
      queuedAheadAtEnqueue: 0,
      activeAheadAtEnqueue: 0,
      taskIdentity: opts?.taskIdentity ? { ...opts.taskIdentity } : undefined,
      sessionTarget: opts?.sessionTarget ? { ...opts.sessionTarget } : undefined,
      onWait: onWait ? (...args) => runInAsyncContext(onWait, ...args) : undefined,
    };
    entry.queuedAheadAtEnqueue = enqueueLaneQueue(state.queue, entry);
    entry.activeAheadAtEnqueue = state.activeTasks.size;
    const signal = opts?.abortSignal;
    if (signal) {
      const onAbort = () => {
        // The once-listener is already detached. Searching for it again scans
        // the remaining listeners when many entries share one abort signal.
        entry.releaseQueuedAbort = undefined;
        if (removeLaneQueueEntry(state.queue, entry)) {
          entry.reject(toErrorObject(signal.reason, "Queued command aborted"));
          retireIdleScopedCommandLane(state);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.releaseQueuedAbort = () => signal.removeEventListener("abort", onAbort);
    }
    logLaneEnqueue(cleaned, getLaneDepth(state));
    drainReadyCommandLane(cleaned);
    if (entry.queued) {
      try {
        opts?.onQueued?.();
      } catch (err) {
        diag.error(`lane onQueued callback failed: lane=${cleaned} error="${String(err)}"`);
      }
    }
  });
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const state = getQueueState().lanes.get(normalizeLane(lane));
  if (!state) {
    return 0;
  }
  return getLaneDepth(state);
}

export function getCommandLaneSnapshot(lane: string = CommandLane.Main): CommandLaneSnapshot {
  const resolved = normalizeLane(lane);
  const state = getQueueState().lanes.get(resolved);
  const snapshot: CommandLaneSnapshot = {
    lane: state?.lane ?? resolved,
    queuedCount: state?.queue.length ?? 0,
    activeCount: state?.activeTasks.size ?? 0,
    maxConcurrent: state?.maxConcurrent ?? getDefaultLaneConcurrency(resolved),
    draining: state?.draining ?? false,
    generation: state?.generation ?? 0,
    blockedBy: null,
    ...(resolved.startsWith(SWARM_LANE_PREFIX)
      ? {
          concurrencyScope: "swarm" as const,
          swarmGroupKey: resolved.slice(SWARM_LANE_PREFIX.length),
        }
      : {}),
  };
  // Missing or retired lanes can still be group members; never recreate them to read capacity.
  applyCommandLaneCapacity(snapshot);
  return snapshot;
}

/** Per-lane work totals for every live lane; diagnostics composition lives in command-lane-diagnostics.ts. */
export function listCommandLaneTotals() {
  return [...getQueueState().lanes.values()].map((state) => ({
    lane: state.lane,
    activeCount: state.activeTasks.size,
    queuedCount: state.queue.length,
  }));
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of getQueueState().lanes.values()) {
    total += getLaneDepth(s);
  }
  return total;
}

/**
 * SIGUSR2 may abandon finally blocks. Retire old active generations while
 * preserving and immediately draining queued user work under the reset state.
 */
export function resetAllLanes(): void {
  const queueState = getQueueState();
  resetGatewayWorkAdmission();
  const lanesToDrain: string[] = [];
  for (const state of queueState.lanes.values()) {
    state.generation += 1;
    state.activeTasks.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  // Drain after the full reset pass so all lanes are in a clean state first.
  for (const lane of lanesToDrain) {
    drainReadyCommandLane(lane);
  }
}
