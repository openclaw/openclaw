import { hasAuthoritativeTaskBacking } from "./task-backing-authority.js";
import { flushTaskActivity } from "./task-registry-activity.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-flow-link.js";
import { publishTaskRecordUpdate } from "./task-registry-mutation.js";
import { captureTaskPersistenceReceipt, cloneTaskRecord } from "./task-registry-records.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunScope,
  tasks,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import {
  runTaskRecordTransitionOperation,
  type TaskRunTransition,
} from "./task-registry-transition.operation.js";
import { tryPersistTaskUpsert } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Legacy adapters retain insertion-order selection and per-row commit/publication. */
export function transitionTaskRecordsByRunNative(transition: TaskRunTransition): TaskRecord[] {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      const matches = getTasksByRunScope(transition.params).map(captureTaskPersistenceReceipt);
      const updated: TaskRecord[] = [];
      for (const selected of matches) {
        const result = runTaskRecordTransitionOperation(
          { ...transition, taskId: selected.taskId, now: Date.now(), selection: selected },
          {
            readCurrent: () => tasks.get(selected.taskId),
            hasAuthoritativeBacking: hasAuthoritativeTaskBacking,
            write: (operation) => operation(),
            beforePersist(receipt) {
              ensureLinkedTaskFlowRegistryReady(receipt.previous);
              ensureLinkedTaskFlowRegistryReady(receipt.task);
              if (receipt.persisted && receipt.becomesTerminal) {
                flushTaskActivity(receipt.task.taskId);
              }
            },
            upsertTask: (task) => tryPersistTaskUpsert(task, "update"),
            deferCommit: (publish) => publish(),
            onCommitted(receipt) {
              publishTaskRecordUpdate(receipt.previous, receipt.task, receipt.persisted);
              if (receipt.deliver) {
                void maybeDeliverTaskStateChangeUpdate(receipt.task.taskId, receipt.nextEvent);
                void maybeDeliverTaskTerminalUpdate(receipt.task.taskId);
              }
            },
          },
        );
        if (result) {
          updated.push(cloneTaskRecord(result.task));
        }
      }
      return updated;
    },
    () => [],
  );
}
