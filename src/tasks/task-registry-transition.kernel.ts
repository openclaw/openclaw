import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  hasAuthoritativeTaskBackingFromRecords,
  selectCurrentCanonicalTaskBacking,
} from "./task-backing-records.js";
import { readTaskFlowRecord } from "./task-flow-registry.store.kernel.js";
import {
  runTaskRecordTransitionOperation,
  type TaskRecordTransitionInput,
  type TaskRecordTransitionOperations,
} from "./task-registry-transition.operation.js";
import {
  bindTaskRecord,
  readTaskRecord,
  readTaskRegistryMutationSnapshotInDatabase,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";
import type { TaskPersistenceReceipt, TaskRecord } from "./task-registry.types.js";

export type { TaskRecordTransitionReceipt } from "./task-registry-transition.operation.js";

type TaskWorkerTransitionInput =
  | (Extract<TaskRecordTransitionInput, { kind: "state" | "run-owner" }> & {
      expectedTask: TaskPersistenceReceipt;
      selection?: never;
    })
  | (Extract<TaskRecordTransitionInput, { kind: "cron-delivery-evidence" }> & {
      expectedTask?: never;
      selection?: never;
    })
  | (Extract<TaskRecordTransitionInput, { kind: "delivery" }> & {
      expectedTask: TaskPersistenceReceipt;
      selection?: never;
    });

export function hasAuthoritativeTaskBackingInDatabase(db: DatabaseSync, task: TaskRecord): boolean {
  return hasAuthoritativeTaskBackingFromRecords(task, {
    isManagedFlow: (flowId) => readTaskFlowRecord(db, flowId)?.syncMode === "managed",
    resolveCurrentCanonicalBacking: (scope) => {
      const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, {
        taskId: task.taskId,
        childSessionKey: scope.childSessionKey,
      });
      return selectCurrentCanonicalTaskBacking({
        ...scope,
        candidates: [...snapshot.tasks.values()],
        isTaskMirroredFlow: (flowId) =>
          readTaskFlowRecord(db, flowId)?.syncMode === "task_mirrored",
      });
    },
  });
}

/** Worker settlement retains an exact task receipt and current host admission. */
export function transitionTaskRecordInDatabase(
  db: DatabaseSync,
  input: TaskWorkerTransitionInput,
  write: <T>(operation: () => T) => T,
  options: Required<Pick<TaskRecordTransitionOperations, "assertCurrent" | "onCommitted">>,
) {
  if (input.kind !== "cron-delivery-evidence" && !input.expectedTask) {
    throw new Error("Worker task transition requires an exact task persistence receipt");
  }
  return runTaskRecordTransitionOperation(input, {
    readCurrent: () => {
      if (!db.isTransaction) {
        throw new Error("Task transition requires a write transaction");
      }
      return readTaskRecord(db, input.taskId);
    },
    hasAuthoritativeBacking: (task) => hasAuthoritativeTaskBackingInDatabase(db, task),
    write,
    upsertTask(task) {
      // No notification bookkeeping changed; preserve the delivery row's exact bytes.
      upsertTaskRunRowInDatabase({ db }, bindTaskRecord(task));
      return true;
    },
    deferCommit(publish) {
      if (!deferSqlitePostCommitPublication(db, publish)) {
        throw new Error("Task transition requires a post-commit publication owner");
      }
    },
    onCommitted: options.onCommitted,
    assertCurrent: options.assertCurrent,
  });
}
