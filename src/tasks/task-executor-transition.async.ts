import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  finishTaskMutation,
  retainTaskMutationFlowEffects,
} from "./task-executor-mutation-effects.async.js";
import type { TaskMutationContext } from "./task-executor.types.js";
import type { TaskInitialWorkerCommand } from "./task-initial-worker.types.js";
import { clearTaskActivity, flushTaskActivity } from "./task-registry-activity.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { isEquivalentTaskRecord, matchesTaskPersistenceReceipt } from "./task-registry-records.js";
import {
  assertTaskRegistryOwnerCurrent,
  runTaskRegistryWorkerMutation,
  tasks,
} from "./task-registry-state.js";
import type { TaskRecordTransitionReceipt } from "./task-registry-transition.kernel.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");

/** Acknowledging a row does not mean its publication and required effects have settled. */
export async function settleTaskRecordTransitionAsync(
  creation: TaskMutationContext,
  command: Extract<
    TaskInitialWorkerCommand,
    { type: "tasks.settleUnstarted" | "tasks.finalizeActive" | "tasks.acknowledgeStateChange" }
  >,
  assertCurrent: () => void,
): Promise<{
  receipt: TaskRecordTransitionReceipt | null;
  publicationSettled: boolean;
}> {
  const { context, store, flowStore, assertStores } = creation;
  const { taskId } = command.input;
  assertCurrent();
  // Activity observers may reenter persistence, so flush before worker admission.
  if (command.type !== "tasks.acknowledgeStateChange") {
    const { expectedTask } = command.input;
    try {
      assertTaskRegistryOwnerCurrent(context, store);
      const projected = tasks.get(taskId);
      if (projected && matchesTaskPersistenceReceipt(projected, expectedTask)) {
        flushTaskActivity(taskId);
      }
    } catch (error) {
      log.warn("Retained task transition no longer owns the active activity projection", {
        taskId,
        error,
      });
    }
  }
  assertCurrent();
  const scope = { taskId };
  let committed: TaskRecordTransitionReceipt | null = null;
  let flowHookEntered = false;
  let flowEffectsSettled = true;
  let publicationFailed = false;
  const settled = await runTaskRegistryWorkerMutation(
    {
      scope,
      admission: context.admission,
      readIdentity: "preserved",
      taskRowsWritten: () => committed?.persisted ?? false,
      publicationRecords: () =>
        new Map<string, TaskRecord>(committed ? [[committed.task.taskId, committed.task]] : []),
      beforeObservers: async () => {
        flowHookEntered = true;
        if (committed) {
          const current = tasks.get(taskId);
          if (
            committed.becomesTerminal &&
            current &&
            isEquivalentTaskRecord(current, committed.task)
          ) {
            clearTaskActivity(taskId);
          }
          flowEffectsSettled = await finishTaskMutation(context, store, flowStore, taskId, {
            operation: "update",
            assertCurrent: assertStores,
          });
        }
      },
      onPublicationError: () => {
        publicationFailed = true;
      },
      forcePublish: () => committed?.task,
    },
    async () => {
      const result = await store.runInitialMutationAsync(context, command, assertCurrent);
      committed = result;
      return result;
    },
    () => store.loadMutationSnapshotAsync(context, scope),
  );
  if (!flowHookEntered && settled) {
    retainTaskMutationFlowEffects(context, store, flowStore, settled.task, "update");
  }
  if (settled?.deliver && settled.task.deliveryStatus !== "not_applicable") {
    try {
      assertTaskRegistryOwnerCurrent(context, store);
      void maybeDeliverTaskStateChangeUpdate(settled.task, settled.nextEvent);
      void maybeDeliverTaskTerminalUpdate(taskId);
    } catch (error) {
      log.warn("Committed task transition could not admit delivery publication", { taskId, error });
    }
  }
  return {
    receipt: settled,
    publicationSettled: flowHookEntered && flowEffectsSettled && !publicationFailed,
  };
}
