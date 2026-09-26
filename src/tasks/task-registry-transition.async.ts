import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import { settleTaskRecordTransitionAsync } from "./task-executor-transition.async.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import {
  captureTaskPersistenceReceipt,
  cloneTaskRecord,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import {
  getTasksByRunScope,
  prepareTaskRegistryProjectionAsync,
  tasks,
} from "./task-registry-state.js";
import { TaskRunTransitionUnsettledError } from "./task-registry-transition.operation.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
import type {
  TaskPersistenceReceipt,
  TaskRecord,
  TaskRunTransition,
} from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

/** Preserve accepted run-update order through preparation, commit, and publication. */
export function transitionTaskRecordsByRunAsync(
  transition: TaskRunTransition,
  assertCurrent?: () => void,
  expectedTask?: TaskPersistenceReceipt,
): Promise<TaskRecord[]> {
  const creation = captureTaskMutationContext();
  const input = structuredClone(transition);
  const expected = expectedTask ? structuredClone(expectedTask) : undefined;
  const assertOwner = () => {
    creation.assertStores();
    assertCurrent?.();
  };
  assertOwner();
  const projection = getTaskRegistryProcessState().projection;
  const operation = (projection.mutationTail ?? Promise.resolve()).then(async () => {
    assertOwner();
    await captureTaskRegistryReadFence(creation.context.admission);
    assertOwner();
    await prepareTaskRegistryProjectionAsync(creation.context, creation.store);
    assertOwner();
    const matches = getTasksByRunScope(input.params).filter(
      (task) => !expected || matchesTaskPersistenceReceipt(task, expected),
    );
    const taskId = input.kind === "state" ? input.params.taskId?.trim() : undefined;
    const selected =
      taskId !== undefined ? matches.find((task) => task.taskId === taskId) : undefined;
    if (taskId !== undefined && !selected) {
      return [];
    }
    const selectedTask = selected
      ? { taskId: selected.taskId, backing: readTaskBackingInstance(selected.detail) }
      : undefined;
    const selections = matches.map((task) => ({
      receipt: captureTaskPersistenceReceipt(task),
      owner: getTaskRunOwner(task),
    }));
    const updated: TaskRecord[] = [];
    for (const selection of selections) {
      assertOwner();
      const refusal = new Error("Task run row changed before transition admission");
      const assertRowCurrent = () => {
        assertOwner();
        const current = tasks.get(selection.receipt.taskId);
        if (
          !current ||
          !matchesTaskPersistenceReceipt(current, selection.receipt) ||
          getTaskRunOwner(current) !== selection.owner
        ) {
          throw refusal;
        }
      };
      try {
        const settlement = await settleTaskRecordTransitionAsync(
          creation,
          {
            type: "tasks.transitionRunRow",
            input: {
              ...input,
              taskId: selection.receipt.taskId,
              expectedTask: selection.receipt,
              selectedTask,
              now: Date.now(),
            },
          },
          assertRowCurrent,
        );
        assertOwner();
        if (settlement.receipt) {
          updated.push(cloneTaskRecord(settlement.receipt.task));
        }
        if (!settlement.publicationSettled) {
          // Native settlement is known; the completion owner still owes this batch.
          throw new TaskRunTransitionUnsettledError(
            "Task run transition publication did not settle.",
          );
        }
      } catch (error) {
        // Only an exact, settled host refusal permits moving to a sibling row.
        if (error !== refusal) {
          throw error;
        }
        assertOwner();
      }
    }
    return updated;
  });
  const tail = operation.then(
    () => {},
    () => {},
  );
  projection.mutationTail = tail;
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (!identity || identity.key === creation.context.admission.identity.key) {
        await tail;
      }
    },
  });
  void tail.then(() => {
    unregister();
    if (projection.mutationTail === tail) {
      delete projection.mutationTail;
    }
  });
  return operation;
}
