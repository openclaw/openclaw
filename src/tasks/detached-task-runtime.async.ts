import { formatErrorMessage } from "../infra/errors.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskAssignmentTransition,
  DetachedTaskCompleteParams,
  DetachedTaskFailParams,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-contract.js";
import { DetachedTaskAssignmentUnsupportedError } from "./detached-task-runtime-contract.js";
import { DetachedTaskLegacyRuntimeError } from "./detached-task-runtime-errors.js";
import { captureDetachedTaskRuntimeOwner } from "./detached-task-runtime-state.js";
import { isIncognitoTask, projectTaskContentForPersistence } from "./task-content.js";
import { createRunningTaskRunCoreAsync } from "./task-executor-create.async.js";
import { transitionTaskRecordsByRunAsync } from "./task-registry-transition.async.js";
import type { TaskRecord, TaskRunTransition } from "./task-registry.types.js";

export async function createRunningTaskRunAsync(
  params: DetachedRunningTaskCreateParams,
  assertCurrent?: () => void,
): Promise<TaskRecord | null> {
  const owner = captureDetachedTaskRuntimeOwner();
  const assertOwner = () => {
    owner.assertCurrent();
    assertCurrent?.();
  };
  assertOwner();
  // The shipped V1 adapter owns its synchronous creation contract, including refusal.
  return owner.runtime
    ? owner.runtime.createRunningTaskRun(
        projectTaskContentForPersistence(isIncognitoTask(params), params),
      )
    : await createRunningTaskRunCoreAsync(params, assertOwner);
}

async function mutateDetachedTask(
  transition: TaskRunTransition,
  legacy: (runtime: DetachedTaskLifecycleRuntime) => TaskRecord[],
  assertCurrent?: () => void,
): Promise<TaskRecord[]> {
  // Transitions settle rows that already exist; they never admit new work.
  const owner = captureDetachedTaskRuntimeOwner({ settlement: true });
  const assertOwner = () => {
    owner.assertCurrent();
    assertCurrent?.();
  };
  assertOwner();
  // The shipped V1 plugin contract returns rows synchronously; retain its owner.
  let result: TaskRecord[];
  if (owner.runtime) {
    try {
      result = legacy(owner.runtime);
    } catch (cause) {
      throw new DetachedTaskLegacyRuntimeError(formatErrorMessage(cause), { cause });
    }
  } else {
    result = await transitionTaskRecordsByRunAsync(transition, assertOwner);
  }
  assertOwner();
  return result;
}

export function startTaskRunByRunIdAsync(
  params: Parameters<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]>[0],
  assertCurrent?: () => void,
) {
  return mutateDetachedTask(
    { kind: "state", params: { ...params, status: "running" } },
    (runtime) => runtime.startTaskRunByRunId(params),
    assertCurrent,
  );
}

export function finalizeTaskRunByRunIdAsync(
  params: DetachedTaskFinalizeParams,
  assertCurrent?: () => void,
) {
  return mutateDetachedTask(
    { kind: "state", params },
    (runtime) =>
      runtime.finalizeTaskRunByRunId
        ? runtime.finalizeTaskRunByRunId(params)
        : params.status === "succeeded"
          ? runtime.completeTaskRunByRunId(params)
          : runtime.failTaskRunByRunId({ ...params, status: params.status }),
    assertCurrent,
  );
}

export function completeTaskRunByRunIdAsync(
  params: DetachedTaskCompleteParams,
  assertCurrent?: () => void,
) {
  return mutateDetachedTask(
    { kind: "state", params: { ...params, status: "succeeded" } },
    (runtime) => runtime.completeTaskRunByRunId(params),
    assertCurrent,
  );
}

export function failTaskRunByRunIdAsync(
  params: DetachedTaskFailParams,
  assertCurrent?: () => void,
) {
  return mutateDetachedTask(
    { kind: "state", params: { ...params, status: params.status ?? "failed" } },
    (runtime) => runtime.failTaskRunByRunId(params),
    assertCurrent,
  );
}

export function setDetachedTaskDeliveryStatusByRunIdAsync(
  params: Parameters<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>[0],
  assertCurrent?: () => void,
) {
  return mutateDetachedTask(
    { kind: "delivery", params },
    (runtime) => runtime.setDetachedTaskDeliveryStatusByRunId(params),
    assertCurrent,
  );
}

/** Exact settlement retains the original assignment while worker admission yields. */
export async function transitionTaskAssignmentAsync(
  params: DetachedTaskAssignmentTransition,
): Promise<TaskRecord[]> {
  const owner = captureDetachedTaskRuntimeOwner({ settlement: true });
  const assertCurrent = () => {
    owner.assertCurrent();
    params.assertCurrent();
  };
  assertCurrent();
  if (owner.runtime) {
    if (!owner.runtime.transitionTaskAssignment) {
      throw new DetachedTaskAssignmentUnsupportedError();
    }
    const result = owner.runtime.transitionTaskAssignment({ ...params, assertCurrent });
    assertCurrent();
    return result;
  }
  const result = await transitionTaskRecordsByRunAsync(
    params.transition,
    assertCurrent,
    params.expectedTask,
  );
  assertCurrent();
  return result;
}
