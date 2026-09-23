import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import {
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
} from "./task-notification-policy.js";
import { sameTaskRunScope } from "./task-registry-records.js";
import {
  prepareTaskRecordUpdate,
  type TaskRecordTransitionReceipt,
} from "./task-registry-transition.operation.js";
import type { TaskDeliveryState, TaskDeliveryStatus, TaskRecord } from "./task-registry.types.js";

export type TaskNotificationTarget = Readonly<
  Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
>;

export type TaskStateNotificationAcknowledgement = {
  taskId: string;
  expectedTask: TaskNotificationTarget;
  eventAt: number;
};

export type TaskNotificationDeliveryOutcome =
  | { kind: "terminal"; deliveryStatus: TaskDeliveryStatus }
  | { kind: "missingStateOwner"; deliveryStatus: "parent_missing" | "not_applicable" };

export type TaskNotificationDeliveryUpdate = {
  taskId: string;
  expectedTask: TaskNotificationTarget;
} & TaskNotificationDeliveryOutcome;

export function captureTaskNotificationTarget(task: TaskRecord): TaskNotificationTarget {
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

export function matchesTaskNotificationTarget(
  task: TaskRecord | undefined,
  target: TaskNotificationTarget,
): task is TaskRecord {
  return task !== undefined && task.taskId === target.taskId && sameTaskRunScope(task, target);
}

export type TaskNotificationOperations = {
  readCurrent: () => { task?: TaskRecord; deliveryState?: TaskDeliveryState };
  write: <T>(operation: () => T) => T;
  assertCurrent: () => void;
  upsertDelivery: (deliveryState: TaskDeliveryState) => void;
  upsertTask: (task: TaskRecord, deliveryState: TaskDeliveryState | undefined) => void;
  deferCommit: (publish: () => void) => void;
  onCommitted: (receipt: TaskRecordTransitionReceipt | null) => void;
  onFailure: (stage: "watermark" | "task", error: unknown) => void;
};

function writeTaskNotificationStage(
  operations: TaskNotificationOperations,
  stage: "watermark" | "task",
  mutate: (assertCurrent: () => void) => void,
): void {
  let refused = false;
  const assertCurrent = () => {
    try {
      operations.assertCurrent();
    } catch (error) {
      refused = true;
      throw error;
    }
  };
  try {
    operations.write(() => mutate(assertCurrent));
  } catch (error) {
    if (refused) {
      throw error;
    }
    operations.onFailure(stage, error);
  }
}

/** The watermark and task touch retain their separate best-effort transactions. */
export function acknowledgeTaskStateNotification(
  input: TaskStateNotificationAcknowledgement,
  operations: TaskNotificationOperations,
): TaskRecordTransitionReceipt | null {
  let selected: boolean | undefined;
  let receipt: TaskRecordTransitionReceipt | null = null;
  writeTaskNotificationStage(operations, "watermark", (assertCurrent) => {
    const current = operations.readCurrent();
    selected = matchesTaskNotificationTarget(current.task, input.expectedTask);
    if (!selected) {
      return;
    }
    const requesterOrigin = normalizeDeliveryContext(current.deliveryState?.requesterOrigin);
    const deliveryState: TaskDeliveryState = {
      taskId: input.taskId,
      ...(requesterOrigin ? { requesterOrigin } : {}),
      lastNotifiedEventAt: Math.max(current.deliveryState?.lastNotifiedEventAt ?? 0, input.eventAt),
    };
    assertCurrent();
    operations.upsertDelivery(deliveryState);
    operations.deferCommit(() => operations.onCommitted(null));
  });
  if (selected === false) {
    return null;
  }
  writeTaskNotificationStage(operations, "task", (assertCurrent) => {
    const current = operations.readCurrent();
    if (!matchesTaskNotificationTarget(current.task, input.expectedTask)) {
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
  return receipt;
}

/** Reread the selected task's policy and metadata in the same transaction as its status write. */
export function updateTaskNotificationDelivery(
  input: TaskNotificationDeliveryUpdate,
  operations: TaskNotificationOperations,
): TaskRecordTransitionReceipt | null {
  let receipt: TaskRecordTransitionReceipt | null = null;
  writeTaskNotificationStage(operations, "task", (assertCurrent) => {
    const current = operations.readCurrent();
    if (
      !matchesTaskNotificationTarget(current.task, input.expectedTask) ||
      !(input.kind === "terminal"
        ? shouldAutoDeliverTaskTerminalUpdate(current.task)
        : shouldAutoDeliverTaskStateChange(current.task))
    ) {
      return;
    }
    const now = Date.now();
    const updated = prepareTaskRecordUpdate(
      current.task,
      { deliveryStatus: input.deliveryStatus, lastEventAt: now },
      now,
    );
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
  return receipt;
}
