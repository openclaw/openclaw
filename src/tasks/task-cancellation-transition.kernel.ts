import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { matchesTaskCancellationSelection } from "./task-cancellation-selection.js";
import { hasAuthoritativeTaskBackingInDatabase } from "./task-registry-transition.kernel.js";
import { runTaskRecordTransitionOperation } from "./task-registry-transition.operation.js";
import {
  bindTaskRecord,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";
import type { TaskRecord, TaskRunStateTransitionParams } from "./task-registry.types.js";

export type TaskCancellationRowInput = {
  taskId: string;
  selectedTask: TaskRecord;
  params: TaskRunStateTransitionParams;
  now: number;
};

export function transitionTaskCancellationRowInDatabase(
  db: DatabaseSync,
  input: TaskCancellationRowInput,
  assertCurrent: () => void,
) {
  if (!db.isTransaction) {
    throw new Error("Task cancellation requires a write transaction");
  }
  return runTaskRecordTransitionOperation(
    { kind: "state", taskId: input.taskId, params: input.params, now: input.now },
    {
      readCurrent() {
        const current = readTaskRecord(db, input.taskId);
        return current && matchesTaskCancellationSelection(current, input.selectedTask)
          ? current
          : undefined;
      },
      hasAuthoritativeBacking: (task) => hasAuthoritativeTaskBackingInDatabase(db, task),
      write: (operation) => operation(),
      upsertTask(task) {
        upsertTaskRunRowInDatabase({ db }, bindTaskRecord(task));
        return true;
      },
      assertCurrent,
      deferCommit(publish) {
        if (!deferSqlitePostCommitPublication(db, publish)) {
          throw new Error("Task cancellation requires a post-commit publication owner");
        }
      },
      onCommitted() {},
    },
  );
}
