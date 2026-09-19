import type { CreatedDetachedTaskRun } from "./detached-task-runtime-contract.js";
import { settleTaskRecordTransitionAsync } from "./task-executor-transition.async.js";
import type { CoreTaskCreation } from "./task-executor.types.js";
import { captureTaskPersistenceReceipt, cloneTaskRecord } from "./task-registry-records.js";
import { getTasksByRunScope, prepareTaskRegistryProjectionAsync } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

export async function finalizeActiveTaskRun(
  creation: CoreTaskCreation,
  task: TaskRecord,
  terminal: Parameters<CreatedDetachedTaskRun["finalizeActive"]>[0],
  canSettle: (task: TaskRecord) => boolean,
): Promise<void> {
  const { context, store, assertStores } = creation;
  const runId = task.runId;
  assertStores();
  if (!runId?.trim() || !canSettle(task)) {
    return;
  }
  const params = {
    ...structuredClone(terminal),
    runId,
    runtime: task.runtime,
    sessionKey: task.childSessionKey,
  };
  await prepareTaskRegistryProjectionAsync(context, store);
  assertStores();
  if (!canSettle(task)) {
    return;
  }
  const selected = getTasksByRunScope(params).map((current) => ({
    task: cloneTaskRecord(current),
    receipt: captureTaskPersistenceReceipt(current),
    owner: getTaskRunOwner(current),
  }));
  for (const selection of selected) {
    assertStores();
    if (!canSettle(task)) {
      break;
    }
    const rowOwned = () => {
      const current = getTaskRunOwner(selection.task);
      return !current || current === selection.owner;
    };
    if (!rowOwned()) {
      continue;
    }
    const rowRefusal = new Error("Active task row was adopted before settlement");
    const assertCurrent = () => {
      assertStores();
      if (!canSettle(task)) {
        throw new Error("Active task finalization lost its original run owner");
      }
      if (!rowOwned()) {
        throw rowRefusal;
      }
    };
    try {
      await settleTaskRecordTransitionAsync(
        creation,
        {
          type: "tasks.finalizeActive",
          input: {
            taskId: selection.receipt.taskId,
            expectedTask: selection.receipt,
            params,
            now: Date.now(),
          },
        },
        assertCurrent,
      );
    } catch (error) {
      // The broker preserves this host error only for a settled admission refusal.
      if (error !== rowRefusal) {
        throw error;
      }
      assertStores();
      if (!canSettle(task)) {
        break;
      }
    }
  }
}
