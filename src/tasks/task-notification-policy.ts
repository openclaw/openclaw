import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

export function shouldAutoDeliverTaskTerminalUpdate(task: TaskRecord): boolean {
  if (task.notifyPolicy === "silent") {
    return false;
  }
  if (task.runtime === "subagent" && task.status !== "cancelled") {
    // Subagent lifecycle owns provider-result publication.
    return false;
  }
  if (isProvisionalSubagentKillTask(task)) {
    // A direct kill is provisional until lifecycle reconciliation settles.
    return false;
  }
  if (!isTerminalTaskStatus(task.status)) {
    return false;
  }
  return task.deliveryStatus === "pending";
}

export function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean {
  return (
    task.notifyPolicy === "state_changes" &&
    task.deliveryStatus === "pending" &&
    !isTerminalTaskStatus(task.status)
  );
}

export function shouldSuppressDuplicateTerminalDelivery(params: {
  task: TaskRecord;
  preferredTaskId?: string;
  peerDeliveryCovered?: boolean;
}): boolean {
  if (!params.task.runId?.trim()) {
    return false;
  }
  const sharesRunDelivery =
    params.task.runtime === "acp" ||
    (params.task.runtime === "subagent" && params.task.status === "cancelled");
  if (!sharesRunDelivery) {
    return false;
  }
  if (params.task.runtime === "subagent" && params.peerDeliveryCovered) {
    return true;
  }
  return Boolean(params.preferredTaskId && params.preferredTaskId !== params.task.taskId);
}
