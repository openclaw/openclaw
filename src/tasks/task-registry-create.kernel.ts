import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { readTaskFlowRecord } from "./task-flow-registry.store.kernel.js";
import { selectExistingTaskForCreate } from "./task-registry-create-rules.js";
import {
  runTaskCreateOperation,
  type TaskCreateInput,
  type TaskCreateOperations,
  type TaskCreateResult,
} from "./task-registry-create.operation.js";
import { assertParentFlowRecordLinkAllowed } from "./task-registry-parent-flow-rules.js";
import {
  readTaskRegistryMutationSnapshotInDatabase,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";

export type { TaskCreateInput, TaskCreateResult } from "./task-registry-create.operation.js";

type TaskCreateOptions = Pick<
  TaskCreateOperations,
  "onCommitted" | "assertCurrent" | "retainTaskCommit"
>;

/** Shared writer custody spans the operation; write owns each separate transaction. */
export function createTaskRecordInDatabase(
  db: DatabaseSync,
  input: TaskCreateInput,
  write: <T>(operation: () => T) => T,
  options: TaskCreateOptions,
): TaskCreateResult {
  const { params } = input;
  return runTaskCreateOperation(input, {
    readSelection: (identity) => {
      const parentFlowId = params.parentFlowId?.trim();
      assertParentFlowRecordLinkAllowed(
        { ...identity, parentFlowId },
        parentFlowId && identity.scopeKind === "session"
          ? readTaskFlowRecord(db, parentFlowId)
          : undefined,
      );
      const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, {
        taskId: input.taskId,
        runId: params.runId,
        childSessionKey: params.childSessionKey,
      });
      const existing = selectExistingTaskForCreate({
        ...params,
        ownerKey: identity.ownerKey,
        scopeKind: identity.scopeKind,
        candidates: [...snapshot.tasks.values()],
        isTaskMirroredFlow: (flowId) =>
          readTaskFlowRecord(db, flowId)?.syncMode === "task_mirrored",
      });
      return {
        existing,
        deliveryState: existing ? snapshot.deliveryStates.get(existing.taskId) : undefined,
      };
    },
    write,
    upsertDelivery: (state) => upsertTaskDeliveryStateInDatabase(db, state),
    upsertTask: (task, deliveryState) =>
      upsertTaskWithDeliveryStateInDatabase({ db }, { task, deliveryState }),
    deferCommit: (publish) => {
      deferSqlitePostCommitPublication(db, publish);
    },
    onCommitted: options.onCommitted,
    assertCurrent: options.assertCurrent,
    retainTaskCommit: options.retainTaskCommit,
  });
}
