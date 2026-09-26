import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import type { FlowRecordPatch } from "./task-flow-registry.records.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export function isOneTaskFlowEligible(task: TaskRecord): boolean {
  if (task.parentFlowId?.trim() || task.scopeKind !== "session") {
    return false;
  }
  if (task.deliveryStatus === "not_applicable") {
    return false;
  }
  return task.runtime === "acp" || task.runtime === "subagent";
}

export function buildManagedFlowCancellationPatch(
  task: Pick<TaskRecord, "endedAt" | "lastEventAt">,
  flow: TaskFlowRecord | undefined,
  readTasks: () => readonly Pick<TaskRecord, "runtime" | "status" | "error">[],
  now: number,
): FlowRecordPatch | undefined {
  if (
    !flow ||
    flow.syncMode !== "managed" ||
    flow.cancelRequestedAt == null ||
    isTerminalTaskFlow(flow) ||
    readTasks().some(isTaskFlowCancellationPending)
  ) {
    return undefined;
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? now;
  return {
    status: "cancelled",
    blockedTaskId: null,
    blockedSummary: null,
    waitJson: null,
    endedAt,
    updatedAt: endedAt,
  };
}
