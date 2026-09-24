import { formatErrorMessage } from "../infra/errors.js";
import type {
  DetachedTaskCompleteParams,
  DetachedTaskFailParams,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-contract.js";
import { DetachedTaskLegacyRuntimeError } from "./detached-task-runtime-errors.js";
import { captureDetachedTaskRuntimeOwner } from "./detached-task-runtime-state.js";
import { transitionTaskRecordsByRunAsync } from "./task-registry-transition.async.js";
import type { TaskRecord, TaskRunTransition } from "./task-registry.types.js";

async function mutateDetachedTask(
  transition: TaskRunTransition,
  legacy: (runtime: DetachedTaskLifecycleRuntime) => TaskRecord[],
  assertCurrent?: () => void,
): Promise<TaskRecord[]> {
  const owner = captureDetachedTaskRuntimeOwner();
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
