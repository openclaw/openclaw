// Provides the runtime adapter for detached task execution.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DetachedTaskAssignmentUnsupportedError } from "./detached-task-runtime-contract.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskRecoveryAttemptParams,
  DetachedTaskRecoveryAttemptResult,
  DetachedTaskFindParams,
  DetachedTaskFindResult,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
  CreatedDetachedTaskRun,
  DetachedTaskAssignmentTransition,
} from "./detached-task-runtime-contract.js";
import {
  captureDetachedTaskRuntimeOwner,
  getRegisteredDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-state.js";
import { cancelTaskById as cancelDetachedTaskRunByIdInCore } from "./runtime-internal.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
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
import { findTaskByRunIdAsync } from "./task-registry-query.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { transitionTaskRecordsByRunNative } from "./task-registry-transition.native.js";
import type { TaskRecord } from "./task-registry.types.js";
import { findTaskByRunIdForStatus, listTasksForSessionKeyForStatus } from "./task-status-access.js";

const log = createSubsystemLogger("tasks/detached-runtime");
const DETACHED_TASK_RECOVERY_WARN_MS = 5_000;

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

/** Exact settlement stays with the registered runtime; unsupported owners never fall through. */
export function transitionTaskAssignment(params: DetachedTaskAssignmentTransition): TaskRecord[] {
  const owner = captureDetachedTaskRuntimeOwner();
  const assertCurrent = () => {
    owner.assertCurrent();
    params.assertCurrent();
  };
  assertCurrent();
  if (!owner.runtime) {
    return transitionTaskRecordsByRunNative(params.transition, {
      expectedTask: params.expectedTask,
      assertCurrent,
    });
  }
  if (!owner.runtime.transitionTaskAssignment) {
    throw new DetachedTaskAssignmentUnsupportedError();
  }
  return owner.runtime.transitionTaskAssignment({ ...params, assertCurrent });
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

type TaskCreationAdmission = { assertCurrent: () => void };

function captureTaskCreationAdmission(
  assertOwnerCurrent: () => void,
  assertCurrent?: () => void,
): { admission: TaskCreationAdmission; close: () => void } {
  let active = true;
  return {
    admission: {
      assertCurrent() {
        if (!active) {
          throw new Error("Detached task creation admission is closed.");
        }
        assertCurrent?.();
        assertOwnerCurrent();
      },
    },
    close() {
      active = false;
    },
  };
}

export type PreparedDetachedTaskRun =
  | {
      kind: "legacy";
      task: TaskRecord | null;
      finalizeRun: (params: DetachedTaskFinalizeParams) => TaskRecord[];
    }
  | { kind: "receipt"; create: () => Promise<CreatedDetachedTaskRun | null> };

/** Preserve synchronous V1 ordering while worker creation retains exact cleanup receipts. */
export function prepareRunningTaskRun(
  params: DetachedRunningTaskCreateParams,
  assertCurrent?: () => void,
): PreparedDetachedTaskRun {
  const owner = captureDetachedTaskRuntimeOwner();
  const runtime = owner.runtime;
  owner.assertCurrent();
  if (!runtime) {
    return {
      kind: "receipt",
      async create() {
        const { admission, close } = captureTaskCreationAdmission(
          owner.assertCurrent,
          assertCurrent,
        );
        try {
          admission.assertCurrent();
          return await createRunningTaskRunCoreWithReceiptAsync(params, admission.assertCurrent);
        } finally {
          close();
        }
      },
    };
  }
  const { admission, close } = captureTaskCreationAdmission(owner.assertCurrent, assertCurrent);
  try {
    const finalize = runtime.finalizeTaskRunByRunId;
    const complete = runtime.completeTaskRunByRunId;
    const fail = runtime.failTaskRunByRunId;
    admission.assertCurrent();
    const task = runtime.createRunningTaskRun(params);
    return {
      kind: "legacy",
      task,
      finalizeRun(terminal) {
        // This is the shipped run-scoped operation, not an exact-task cleanup receipt.
        owner.assertCurrent();
        if (finalize) {
          return finalize.call(runtime, terminal);
        }
        return terminal.status === "succeeded"
          ? complete.call(runtime, terminal)
          : fail.call(runtime, { ...terminal, status: terminal.status });
      },
    };
  } finally {
    close();
  }
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

/** Async lifecycle owners join accepted task writes without entering native writer custody. */
export async function findDetachedTaskRunAsync(
  params: DetachedTaskFindParams,
): Promise<DetachedTaskFindResult> {
  const owner = captureDetachedTaskRuntimeOwner();
  try {
    owner.assertCurrent();
    if (owner.runtime?.findTaskRun) {
      const task = owner.runtime.findTaskRun(params);
      owner.assertCurrent();
      return { lookup: "available", task };
    }
    const read = await prepareTaskRegistryRead();
    owner.assertCurrent();
    if (!read) {
      return { lookup: "unavailable" };
    }
    const direct = await findTaskByRunIdAsync(params.runId, read);
    owner.assertCurrent();
    read.assertCurrent();
    const task =
      direct && taskMatchesFindIdentity(direct, params)
        ? direct
        : params.allowSessionFallback === true
          ? read
              .listTasksForRelatedSessionKey(params.sessionKey)
              .find((candidate) => taskMatchesFindScope(candidate, params))
          : undefined;
    // A legacy custom runtime without a lookup hook cannot prove absence in its own store.
    return task || !owner.runtime ? { lookup: "available", task } : { lookup: "unavailable" };
  } catch (error) {
    log.warn("Detached task lookup failed", {
      runtime: params.runtime,
      runId: params.runId,
      error,
    });
    return { lookup: "unavailable" };
  }
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
