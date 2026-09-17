import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  hasAuthoritativeTaskBackingFromRecords,
  selectCurrentCanonicalTaskBacking,
} from "./task-backing-records.js";
import { readTaskFlowRecord } from "./task-flow-registry.store.kernel.js";
import { filterTasksByRunScope } from "./task-registry-records.js";
import {
  runTaskRecordTransitionOperation,
  type TaskRecordTransitionInput,
  type TaskRecordTransitionOperations,
  type TaskRunTransition,
} from "./task-registry-transition.operation.js";
import {
  bindTaskRecord,
  readTaskRecord,
  readTaskRegistryMutationSnapshotInDatabase,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";

export type { TaskRecordTransitionReceipt } from "./task-registry-transition.operation.js";

/** Return fresh scoped rows in canonical persisted order, never host insertion order. */
function selectTaskRunTransitionRecordsInDatabase(
  db: DatabaseSync,
  params: TaskRunTransition["params"],
) {
  const runId = params.runId.trim();
  if (!runId) {
    return [];
  }
  const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, { runId });
  return filterTasksByRunScope([...snapshot.tasks.values()], params);
}

/** The host settles one row's publication/effects before admitting its next sibling. */
export function transitionTaskRecordInDatabase(
  db: DatabaseSync,
  input: TaskRecordTransitionInput,
  write: <T>(operation: () => T) => T,
  options: Pick<TaskRecordTransitionOperations, "assertCurrent" | "onCommitted">,
) {
  return runTaskRecordTransitionOperation(input, {
    readCurrent: () => {
      if (!db.isTransaction) {
        throw new Error("Task transition requires a write transaction");
      }
      if (input.selection) {
        return readTaskRecord(db, input.taskId);
      }
      return selectTaskRunTransitionRecordsInDatabase(db, input.params).find(
        (task) => task.taskId === input.taskId,
      );
    },
    hasAuthoritativeBacking: (task) =>
      hasAuthoritativeTaskBackingFromRecords(task, {
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
      }),
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
