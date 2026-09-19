import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { TaskRecordTransitionReceipt } from "./task-registry-transition.operation.js";
import {
  readTaskRegistryMutationSnapshotInDatabase,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";
import {
  acknowledgeTaskStateNotification,
  type TaskStateNotificationAcknowledgement,
} from "./task-state-notification-ack.operation.js";

const log = createSubsystemLogger("tasks/registry");

export function acknowledgeTaskStateNotificationInDatabase(
  db: DatabaseSync,
  input: TaskStateNotificationAcknowledgement,
  write: <T>(operation: () => T) => T,
  options: {
    assertCurrent: () => void;
    onCommitted: (receipt: TaskRecordTransitionReceipt | null) => void;
  },
): TaskRecordTransitionReceipt | null {
  return acknowledgeTaskStateNotification(input, {
    readCurrent() {
      if (!db.isTransaction) {
        throw new Error("Notification acknowledgement requires a write transaction");
      }
      const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, { taskId: input.taskId });
      return {
        task: snapshot.tasks.get(input.taskId),
        deliveryState: snapshot.deliveryStates.get(input.taskId),
      };
    },
    write,
    assertCurrent: options.assertCurrent,
    upsertDelivery: (state) => upsertTaskDeliveryStateInDatabase(db, state),
    upsertTask: (task, deliveryState) =>
      upsertTaskWithDeliveryStateInDatabase({ db }, { task, deliveryState }),
    deferCommit(publish) {
      if (!deferSqlitePostCommitPublication(db, publish)) {
        throw new Error("Notification acknowledgement requires a post-commit publication owner");
      }
    },
    onCommitted: options.onCommitted,
    onFailure(stage, error) {
      log.warn("Failed to persist task state notification acknowledgement", {
        taskId: input.taskId,
        stage,
        error,
      });
    },
  });
}
