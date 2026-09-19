import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { sameTaskRunScope } from "./task-registry-records.js";
import {
  prepareTaskRecordUpdate,
  type TaskRecordTransitionReceipt,
} from "./task-registry-transition.operation.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type TaskStateNotificationTarget = Readonly<
  Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
>;

export type TaskStateNotificationAcknowledgement = {
  taskId: string;
  expectedTask: TaskStateNotificationTarget;
  eventAt: number;
};

export function captureTaskStateNotificationTarget(task: TaskRecord): TaskStateNotificationTarget {
  // Lifecycle timestamps may normalize while transport waits; the task's run scope stays fixed.
  return Object.freeze({
    taskId: task.taskId,
    runtime: task.runtime,
    ownerKey: task.ownerKey,
    scopeKind: task.scopeKind,
    runId: task.runId,
    childSessionKey: task.childSessionKey,
  });
}

type TaskStateNotificationOperations = {
  readCurrent: () => { task?: TaskRecord; deliveryState?: TaskDeliveryState };
  write: <T>(operation: () => T) => T;
  assertCurrent: () => void;
  upsertDelivery: (deliveryState: TaskDeliveryState) => void;
  upsertTask: (task: TaskRecord, deliveryState: TaskDeliveryState | undefined) => void;
  deferCommit: (publish: () => void) => void;
  onCommitted: (receipt: TaskRecordTransitionReceipt | null) => void;
  onFailure: (stage: "watermark" | "task", error: unknown) => void;
};

/** The watermark and task touch retain their separate best-effort transactions. */
export function acknowledgeTaskStateNotification(
  input: TaskStateNotificationAcknowledgement,
  operations: TaskStateNotificationOperations,
): TaskRecordTransitionReceipt | null {
  let selected: boolean | undefined;
  let receipt: TaskRecordTransitionReceipt | null = null;
  let refused = false;
  const assertCurrent = () => {
    try {
      operations.assertCurrent();
    } catch (error) {
      refused = true;
      throw error;
    }
  };
  const matches = (task: TaskRecord | undefined): task is TaskRecord =>
    task !== undefined &&
    task.taskId === input.expectedTask.taskId &&
    sameTaskRunScope(task, input.expectedTask);
  try {
    operations.write(() => {
      const current = operations.readCurrent();
      selected = matches(current.task);
      if (!selected) {
        return;
      }
      const requesterOrigin = normalizeDeliveryContext(current.deliveryState?.requesterOrigin);
      const deliveryState: TaskDeliveryState = {
        taskId: input.taskId,
        ...(requesterOrigin ? { requesterOrigin } : {}),
        lastNotifiedEventAt: Math.max(
          current.deliveryState?.lastNotifiedEventAt ?? 0,
          input.eventAt,
        ),
      };
      assertCurrent();
      operations.upsertDelivery(deliveryState);
      operations.deferCommit(() => operations.onCommitted(null));
    });
  } catch (error) {
    if (refused) {
      throw error;
    }
    operations.onFailure("watermark", error);
  }
  if (selected === false) {
    return null;
  }
  try {
    operations.write(() => {
      const current = operations.readCurrent();
      if (!matches(current.task)) {
        return;
      }
      const now = Date.now();
      const updated = prepareTaskRecordUpdate(current.task, { lastEventAt: now }, now);
      assertCurrent();
      if (updated.persisted) {
        operations.upsertTask(updated.task, current.deliveryState);
      }
      const committed = { ...updated, deliver: false };
      operations.deferCommit(() => {
        receipt = committed;
        operations.onCommitted(committed);
      });
    });
  } catch (error) {
    if (refused) {
      throw error;
    }
    operations.onFailure("task", error);
  }
  return receipt;
}
