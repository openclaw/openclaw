import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import { selectExistingTaskForCreate } from "./task-registry-create-rules.js";
import { getTasksByRunId } from "./task-registry.process-state.js";
import type { TaskRecord } from "./task-registry.types.js";

export function findExistingTaskForCreate(
  params: Omit<
    Parameters<typeof selectExistingTaskForCreate>[0],
    "candidates" | "isTaskMirroredFlow"
  >,
): TaskRecord | undefined {
  return selectExistingTaskForCreate({
    ...params,
    candidates: params.runId?.trim() ? getTasksByRunId(params.runId) : [],
    isTaskMirroredFlow: (flowId) => getTaskFlowById(flowId)?.syncMode === "task_mirrored",
  });
}
