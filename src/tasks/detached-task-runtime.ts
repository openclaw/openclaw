// Provides the runtime adapter for detached task execution.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  DetachedTaskRecoveryAttemptParams,
  DetachedTaskRecoveryAttemptResult,
  DetachedTaskFindParams,
  DetachedTaskFindResult,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-contract.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state.js";
import { cancelTaskById as cancelDetachedTaskRunByIdInCore } from "./runtime-internal.js";
import {
  isAuthorizedManagedTaskProjection,
  isManagedTaskProjection,
  validateSubagentTaskBacking,
  type SubagentTaskBackingPolicy,
} from "./task-backing-authority.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import {
  completeTaskRunByRunIdCore,
  createQueuedTaskRunCore,
  createRunningTaskRunCore,
  failTaskRunByRunIdCore,
  finalizeTaskRunByRunIdCore,
  recordTaskRunProgressByRunIdCore,
  setDetachedTaskDeliveryStatusByRunIdCore,
  startTaskRunByRunIdCore,
} from "./task-executor.js";
import {
  finalizeTaskRecordsByExpectedSnapshots,
  updateTaskDeliveryByExpectedSnapshots,
} from "./task-registry-record-api.js";
import { ensureTaskRegistryReady, getTasksByRunScope } from "./task-registry-state.js";
import { bindTaskRecord, replaceTaskRunRowInDatabase } from "./task-registry.store.sqlite.js";
import type { TaskRecord, TaskRuntime } from "./task-registry.types.js";
import { findTaskByRunIdForStatus, listTasksForSessionKeyForStatus } from "./task-status-access.js";

const log = createSubsystemLogger("tasks/detached-runtime");
const DETACHED_TASK_RECOVERY_WARN_MS = 5_000;

export type DefaultSubagentTaskBackingResult =
  | { kind: "custom" }
  | { kind: "valid"; task: TaskRecord; projections: TaskRecord[] }
  | { kind: "invalid"; reason: string };

export function inspectDefaultSubagentTaskBacking(params: {
  runId: string;
  ownerKey: string;
  sessionKey: string;
  generation: number | undefined;
  policy: SubagentTaskBackingPolicy;
  preserveTerminalState?: boolean;
}): DefaultSubagentTaskBackingResult {
  if (getRegisteredDetachedTaskLifecycleRuntime()) {
    return { kind: "custom" };
  }
  ensureTaskRegistryReady();
  const candidates = getTasksByRunScope({
    runId: params.runId,
    runtime: "subagent",
    sessionKey: params.sessionKey,
  });
  const canonicalCandidates = candidates.filter((candidate) => !isManagedTaskProjection(candidate));
  if (canonicalCandidates.length > 1) {
    return { kind: "invalid", reason: "is ambiguous" };
  }
  const validation = validateSubagentTaskBacking({
    task: canonicalCandidates[0],
    runId: params.runId,
    ownerKey: params.ownerKey,
    childSessionKey: params.sessionKey,
    generation: params.generation,
    policy: params.policy,
    preserveTerminalState: params.preserveTerminalState,
  });
  if (!validation.ok) {
    return { kind: "invalid", reason: validation.reason };
  }
  return {
    kind: "valid",
    task: validation.task,
    projections: candidates.filter(
      (candidate) =>
        candidate.taskId !== validation.task.taskId &&
        isAuthorizedManagedTaskProjection({
          task: candidate,
          canonical: validation.task,
        }),
    ),
  };
}

export function assertDefaultSubagentTaskBacking(
  params: Parameters<typeof inspectDefaultSubagentTaskBacking>[0],
): TaskRecord | undefined {
  const result = inspectDefaultSubagentTaskBacking(params);
  if (result.kind === "invalid") {
    throw new Error(
      `Collector task backing ${result.reason}. Retry the collector request to create a fresh run.`,
    );
  }
  return result.kind === "valid" ? result.task : undefined;
}

function taskMatchesFindScope(task: TaskRecord, params: DetachedTaskFindParams): boolean {
  return (
    task.runtime === params.runtime &&
    task.childSessionKey === params.sessionKey &&
    task.createdAt >= params.createdAtOrAfter &&
    (params.createdBefore === undefined || task.createdAt < params.createdBefore)
  );
}

function taskMatchesFindIdentity(task: TaskRecord, params: DetachedTaskFindParams): boolean {
  return task.runtime === params.runtime && task.childSessionKey === params.sessionKey;
}

function findCoreTaskRun(params: DetachedTaskFindParams): TaskRecord | undefined {
  const direct = findTaskByRunIdForStatus(params.runId);
  if (direct && taskMatchesFindIdentity(direct, params)) {
    return direct;
  }
  if (params.allowSessionFallback !== true) {
    return undefined;
  }
  return listTasksForSessionKeyForStatus(params.sessionKey).find((task) =>
    taskMatchesFindScope(task, params),
  );
}

export function acceptDefaultPreparedTaskRunAtomically(params: {
  runId: string;
  runtime: TaskRuntime;
  sessionKey: string;
  ownerKey: string;
  generation: number | undefined;
  acceptedAt: number;
  preserveTaskState?: boolean;
  commitPeer: () => void;
}): TaskRecord | null {
  const expected = assertDefaultSubagentTaskBacking({
    runId: params.runId,
    ownerKey: params.ownerKey,
    sessionKey: params.sessionKey,
    generation: params.generation,
    policy: "gateway-acceptance",
    preserveTerminalState: params.preserveTaskState,
  });
  if (!expected) {
    return null;
  }
  if (expected.runtime !== params.runtime) {
    throw new Error("prepared task runtime changed before atomic acceptance");
  }
  const next = params.preserveTaskState
    ? expected
    : {
        ...expected,
        status: "running" as const,
        startedAt: params.acceptedAt,
        lastEventAt: params.acceptedAt,
      };
  runOpenClawStateWriteTransaction((database) => {
    if (
      !replaceTaskRunRowInDatabase({
        database,
        expected: bindTaskRecord(expected),
        next: bindTaskRecord(next),
      })
    ) {
      throw new Error("prepared task state changed before atomic acceptance");
    }
    params.commitPeer();
  });
  return next;
}

// Default runtime keeps detached task APIs usable before plugins install custom lifecycle hooks.
const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME: DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: createQueuedTaskRunCore,
  createRunningTaskRun: createRunningTaskRunCore,
  startTaskRunByRunId: startTaskRunByRunIdCore,
  recordTaskRunProgressByRunId: recordTaskRunProgressByRunIdCore,
  finalizeTaskRunByRunId: finalizeTaskRunByRunIdCore,
  completeTaskRunByRunId: completeTaskRunByRunIdCore,
  failTaskRunByRunId: failTaskRunByRunIdCore,
  setDetachedTaskDeliveryStatusByRunId: setDetachedTaskDeliveryStatusByRunIdCore,
  findTaskRun: findCoreTaskRun,
  cancelDetachedTaskRunById: cancelDetachedTaskRunByIdInCore,
};

export function getDetachedTaskLifecycleRuntime(): DetachedTaskLifecycleRuntime {
  return getRegisteredDetachedTaskLifecycleRuntime() ?? DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}

export function isDefaultDetachedTaskLifecycleRuntime(): boolean {
  return getRegisteredDetachedTaskLifecycleRuntime() === undefined;
}

export function createQueuedTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]> {
  return getDetachedTaskLifecycleRuntime().createQueuedTaskRun(...args);
}

export function createRunningTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createRunningTaskRun"]> {
  return getDetachedTaskLifecycleRuntime().createRunningTaskRun(...args);
}

export function startTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().startTaskRunByRunId(...args);
}

export function recordTaskRunProgressByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]> {
  return getDetachedTaskLifecycleRuntime().recordTaskRunProgressByRunId(...args);
}

export function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): TaskRecord[] {
  const runtime = getDetachedTaskLifecycleRuntime();
  if (runtime.finalizeTaskRunByRunId) {
    return runtime.finalizeTaskRunByRunId(params);
  }
  if (params.status === "succeeded") {
    return runtime.completeTaskRunByRunId(params);
  }
  return runtime.failTaskRunByRunId({
    ...params,
    status: params.status,
  });
}

/**
 * Finalizes only the task minted by one subagent owner generation.
 * Custom runtimes retain their own lookup and persistence contract.
 */
export function finalizeSubagentTaskRunForOwner(params: {
  runId: string;
  ownerKey: string;
  sessionKey: string;
  generation: number | undefined;
  resolvedTask?: TaskRecord;
  status: DetachedTaskFinalizeParams["status"];
  startedAt?: number;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  clearError?: boolean;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: DetachedTaskFinalizeParams["terminalOutcome"];
  detail?: DetachedTaskFinalizeParams["detail"];
  suppressDelivery?: boolean;
  preserveTerminalState?: boolean;
}): TaskRecord[] {
  const runtime = getRegisteredDetachedTaskLifecycleRuntime();
  if (runtime) {
    const {
      ownerKey: _ownerKey,
      generation: _generation,
      resolvedTask,
      preserveTerminalState: _preserveTerminalState,
      ...finalizeParams
    } = params;
    return finalizeTaskRunByRunId({
      ...finalizeParams,
      runId: resolvedTask?.runId ?? params.runId,
      runtime: "subagent",
      sessionKey: resolvedTask?.childSessionKey ?? params.sessionKey,
    });
  }
  const backing = inspectDefaultSubagentTaskBacking({
    runId: params.runId,
    ownerKey: params.ownerKey,
    sessionKey: params.sessionKey,
    generation: params.generation,
    policy: "failure-finalization",
  });
  if (backing.kind !== "valid") {
    return [];
  }
  if (params.preserveTerminalState && isTerminalTaskStatus(backing.task.status)) {
    return [];
  }
  return finalizeTaskRecordsByExpectedSnapshots({
    ...params,
    expected: [backing.task, ...backing.projections],
  });
}

export function setSubagentTaskDeliveryStatusForOwner(params: {
  runId: string;
  ownerKey: string;
  sessionKey: string;
  generation: number | undefined;
  resolvedTask?: TaskRecord;
  deliveryStatus: TaskRecord["deliveryStatus"];
  error?: string;
}): TaskRecord[] {
  const runtime = getRegisteredDetachedTaskLifecycleRuntime();
  if (runtime) {
    const {
      ownerKey: _ownerKey,
      generation: _generation,
      resolvedTask,
      ...deliveryParams
    } = params;
    return setDetachedTaskDeliveryStatusByRunId({
      ...deliveryParams,
      runId: resolvedTask?.runId ?? params.runId,
      runtime: "subagent",
      sessionKey: resolvedTask?.childSessionKey ?? params.sessionKey,
    });
  }
  const backing = inspectDefaultSubagentTaskBacking({
    runId: params.runId,
    ownerKey: params.ownerKey,
    sessionKey: params.sessionKey,
    generation: params.generation,
    policy: "failure-finalization",
  });
  if (backing.kind !== "valid") {
    return [];
  }
  return updateTaskDeliveryByExpectedSnapshots({
    expected: [backing.task, ...backing.projections],
    deliveryStatus: params.deliveryStatus,
    error: params.error,
  });
}

export function completeTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().completeTaskRunByRunId(...args);
}

export function failTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().failTaskRunByRunId(...args);
}

export function setDetachedTaskDeliveryStatusByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]> {
  return getDetachedTaskLifecycleRuntime().setDetachedTaskDeliveryStatusByRunId(...args);
}

export function findDetachedTaskRun(params: DetachedTaskFindParams): DetachedTaskFindResult {
  const runtime = getDetachedTaskLifecycleRuntime();
  if (runtime.findTaskRun) {
    try {
      return { lookup: "available", task: runtime.findTaskRun(params) };
    } catch (error) {
      log.warn("Detached task lookup failed", {
        runtime: params.runtime,
        runId: params.runId,
        error,
      });
      return { lookup: "unavailable" };
    }
  }
  const coreTask = findCoreTaskRun(params);
  // Older custom runtimes may mirror records into core. When they do not, an
  // empty fallback cannot prove that the runtime-owned task is absent.
  return coreTask ? { lookup: "available", task: coreTask } : { lookup: "unavailable" };
}

export async function tryRecoverTaskBeforeMarkLost(
  params: DetachedTaskRecoveryAttemptParams,
): Promise<DetachedTaskRecoveryAttemptResult> {
  const hook = getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost;
  if (!hook) {
    return { recovered: false };
  }
  const startedAt = Date.now();
  try {
    // Recovery hooks are best-effort; invalid/slow/failing hooks must not block mark-lost cleanup.
    const result = await hook(params);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= DETACHED_TASK_RECOVERY_WARN_MS) {
      log.warn("Detached task recovery hook was slow", {
        taskId: params.taskId,
        runtime: params.runtime,
        elapsedMs,
      });
    }
    if (result && typeof result.recovered === "boolean") {
      return result;
    }
    log.warn("Detached task recovery hook returned invalid result, proceeding with markTaskLost", {
      taskId: params.taskId,
      runtime: params.runtime,
      result,
    });
    return { recovered: false };
  } catch (err) {
    log.warn("Detached task recovery hook threw, proceeding with markTaskLost", {
      taskId: params.taskId,
      runtime: params.runtime,
      elapsedMs: Date.now() - startedAt,
      error: err,
    });
    return { recovered: false };
  }
}
