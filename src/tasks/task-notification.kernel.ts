import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  acknowledgeTaskStateNotification,
  updateTaskNotificationDelivery,
  type TaskNotificationDeliveryUpdate,
  type TaskNotificationOperations,
  type TaskStateNotificationAcknowledgement,
} from "./task-notification.operation.js";
import type { TaskRecordTransitionReceipt } from "./task-registry-transition.operation.js";
import {
  readTaskRegistryMutationSnapshotInDatabase,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";

const log = createSubsystemLogger("tasks/registry");

type TaskNotificationKernelOptions = {
  assertCurrent: () => void;
  onCommitted: (receipt: TaskRecordTransitionReceipt | null) => void;
};

function taskNotificationOperations(
  db: DatabaseSync,
  taskId: string,
  write: <T>(operation: () => T) => T,
  options: TaskNotificationKernelOptions,
): TaskNotificationOperations {
  return {
    readCurrent() {
      if (!db.isTransaction) {
        throw new Error("Task notification mutation requires a write transaction");
      }
      const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, { taskId });
      return {
        task: snapshot.tasks.get(taskId),
        deliveryState: snapshot.deliveryStates.get(taskId),
      };
    },
    write,
    assertCurrent: options.assertCurrent,
    upsertDelivery: (state) => upsertTaskDeliveryStateInDatabase(db, state),
    upsertTask: (task, deliveryState) =>
      upsertTaskWithDeliveryStateInDatabase({ db }, { task, deliveryState }),
    deferCommit(publish) {
      if (!deferSqlitePostCommitPublication(db, publish)) {
        throw new Error("Task notification mutation requires a post-commit publication owner");
      }
    },
    onCommitted: options.onCommitted,
    onFailure(stage, error) {
      log.warn("Failed to persist task notification mutation", {
        taskId,
        stage,
        error,
      });
    },
  };
}

export function acknowledgeTaskStateNotificationInDatabase(
  db: DatabaseSync,
  input: TaskStateNotificationAcknowledgement,
  write: <T>(operation: () => T) => T,
  options: TaskNotificationKernelOptions,
): TaskRecordTransitionReceipt | null {
  return acknowledgeTaskStateNotification(
    input,
    taskNotificationOperations(db, input.taskId, write, options),
  );
}

export function updateTaskNotificationDeliveryInDatabase(
  db: DatabaseSync,
  input: TaskNotificationDeliveryUpdate,
  write: <T>(operation: () => T) => T,
  options: TaskNotificationKernelOptions,
): TaskRecordTransitionReceipt | null {
  return updateTaskNotificationDelivery(
    input,
    taskNotificationOperations(db, input.taskId, write, options),
  );
}
