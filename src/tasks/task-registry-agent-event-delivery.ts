import type { TaskAgentEventPublication } from "./task-registry-agent-event.operation.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { isEquivalentTaskRecord } from "./task-registry-records.js";
import { tasks } from "./task-registry-state.js";
import { isTerminalTaskStatus } from "./task-registry.types.js";

export type TaskAgentEventDelivery = {
  receipt: TaskAgentEventPublication;
  isCurrent: () => boolean;
};

export function publishTaskAgentEventDelivery(
  delivery: TaskAgentEventDelivery,
  assertCurrent: () => void,
): void {
  const { receipt } = delivery;
  try {
    assertCurrent();
  } catch {
    return;
  }
  const current = tasks.get(receipt.task.taskId);
  if (!current || !delivery.isCurrent() || !isEquivalentTaskRecord(current, receipt.task)) {
    return;
  }
  if (receipt.task.deliveryStatus === "not_applicable" || receipt.task.notifyPolicy === "silent") {
    return;
  }
  if (receipt.nextEvent) {
    void maybeDeliverTaskStateChangeUpdate(receipt.task, receipt.nextEvent);
  }
  if (isTerminalTaskStatus(receipt.task.status)) {
    void maybeDeliverTaskTerminalUpdate(receipt.task.taskId);
  }
}
