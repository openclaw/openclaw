import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { matchesTaskCancellationSelection } from "./task-cancellation-selection.js";
import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import { settleTaskRecordTransitionAsync } from "./task-executor-transition.async.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { prepareTaskRegistryProjectionAsync, tasks } from "./task-registry-state.js";
import { TaskRunTransitionUnsettledError } from "./task-registry-transition.operation.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
import type { TaskRecord, TaskRunStateTransitionParams } from "./task-registry.types.js";

/** Runless legacy rows still settle through the task worker's publication owner. */
export function transitionTaskCancellationRowAsync(
  selected: TaskRecord,
  params: TaskRunStateTransitionParams,
  assertCurrent: () => void,
): Promise<TaskRecord[]> {
  const creation = captureTaskMutationContext();
  const input = {
    taskId: selected.taskId,
    selectedTask: cloneTaskRecord(selected),
    params: structuredClone(params),
    now: Date.now(),
  };
  const guard = () => {
    creation.assertStores();
    assertCurrent();
    const current = tasks.get(input.taskId);
    if (!current || !matchesTaskCancellationSelection(current, input.selectedTask)) {
      throw new Error("Task changed while cancellation was in progress.");
    }
  };
  guard();
  const projection = getTaskRegistryProcessState().projection;
  const operation = (projection.mutationTail ?? Promise.resolve()).then(async () => {
    await captureTaskRegistryReadFence(creation.context.admission);
    await prepareTaskRegistryProjectionAsync(creation.context, creation.store);
    guard();
    const result = await settleTaskRecordTransitionAsync(
      creation,
      { type: "tasks.cancelRow", input },
      guard,
    );
    if (!result.publicationSettled) {
      throw new TaskRunTransitionUnsettledError("Task cancellation publication did not settle.");
    }
    return result.receipt ? [cloneTaskRecord(result.receipt.task)] : [];
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
