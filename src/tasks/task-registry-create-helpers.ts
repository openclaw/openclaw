import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { getTaskMirroredFlowIds } from "./task-flow-runtime-internal.js";
import {
  buildTaskCreateMergePatch,
  selectExistingTaskForCreate,
  type TaskCreateMergeParams,
} from "./task-registry-create-rules.js";
import {
  assertParentFlowLinkAllowed,
  ensureLinkedTaskFlowRegistryReady,
} from "./task-registry-flow-link.js";
import { updateTask, upsertTaskDeliveryState } from "./task-registry-mutation.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { getTasksByRunId, taskDeliveryStates } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

export function findExistingTaskForCreate(
  params: Omit<
    Parameters<typeof selectExistingTaskForCreate>[0],
    "candidates" | "isTaskMirroredFlow"
  >,
): TaskRecord | undefined {
  const candidates = params.runId?.trim() ? getTasksByRunId(params.runId) : [];
  let mirroredFlowIds: ReadonlySet<string> | undefined;
  return selectExistingTaskForCreate({
    ...params,
    candidates,
    isTaskMirroredFlow: (flowId) => {
      mirroredFlowIds ??= getTaskMirroredFlowIds(
        candidates.flatMap((task) => (task.parentFlowId ? [task.parentFlowId.trim()] : [])),
      );
      return mirroredFlowIds.has(flowId);
    },
  });
}

export function mergeExistingTaskForCreate(
  existing: TaskRecord,
  params: TaskCreateMergeParams,
): TaskRecord | null {
  ensureLinkedTaskFlowRegistryReady(existing);
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const currentDeliveryState = taskDeliveryStates.get(existing.taskId);
  if (requesterOrigin && !currentDeliveryState?.requesterOrigin) {
    const deliveryState = upsertTaskDeliveryState({
      taskId: existing.taskId,
      requesterOrigin,
      lastNotifiedEventAt: currentDeliveryState?.lastNotifiedEventAt,
    });
    if (!deliveryState.requesterOrigin) {
      return null;
    }
  }
  if (params.parentFlowId?.trim() && !existing.parentFlowId?.trim()) {
    assertParentFlowLinkAllowed({
      ownerKey: existing.ownerKey,
      scopeKind: existing.scopeKind,
      parentFlowId: params.parentFlowId,
    });
  }
  const patch = buildTaskCreateMergePatch(existing, params);
  return Object.keys(patch).length === 0
    ? cloneTaskRecord(existing)
    : updateTask(existing.taskId, patch);
}
