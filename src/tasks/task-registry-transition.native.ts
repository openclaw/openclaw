import {
  getManagedTaskBackingInstance,
  hasAuthoritativeTaskBacking,
  readTaskBackingInstance,
} from "./task-backing-authority.js";
import { readManagedTaskBacking, sameTaskBackingInstance } from "./task-backing-records.js";
import { flushTaskActivity } from "./task-registry-activity.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-flow-link.js";
import { publishTaskRecordUpdate } from "./task-registry-mutation.js";
import {
  captureTaskPersistenceReceipt,
  cloneTaskRecord,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunScope,
  tasks,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import { runTaskRecordTransitionOperation } from "./task-registry-transition.operation.js";
import { tryPersistTaskUpsert } from "./task-registry.store.js";
import type {
  TaskPersistenceReceipt,
  TaskRecord,
  TaskRunTransition,
} from "./task-registry.types.js";

/** Legacy adapters retain insertion-order selection and per-row commit/publication. */
export function transitionTaskRecordsByRunNative(
  transition: TaskRunTransition,
  ownership?: { expectedTask: TaskPersistenceReceipt; assertCurrent: () => void },
): TaskRecord[] {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      const matches = getTasksByRunScope(transition.params).filter(
        (task) => !ownership || matchesTaskPersistenceReceipt(task, ownership.expectedTask),
      );
      const taskId = transition.kind === "state" ? transition.params.taskId : undefined;
      const selectedTask =
        taskId !== undefined ? matches.find((task) => task.taskId === taskId.trim()) : undefined;
      if (taskId !== undefined && !selectedTask) {
        return [];
      }
      const selectedBacking = selectedTask
        ? readTaskBackingInstance(selectedTask.detail)
        : undefined;
      const selections = matches.map(captureTaskPersistenceReceipt);
      const updated: TaskRecord[] = [];
      for (const selected of selections) {
        const result = runTaskRecordTransitionOperation(
          {
            ...transition,
            taskId: selected.taskId,
            now: Date.now(),
            selection: selected,
            expectedTask: ownership?.expectedTask,
          },
          {
            assertCurrent: ownership?.assertCurrent,
            readCurrent: () => {
              const beforeRestore = tasks.get(selected.taskId);
              if (beforeRestore) {
                ensureLinkedTaskFlowRegistryReady(beforeRestore);
              }
              // Restoring linked flows can synchronously replace or remove this task.
              const current = tasks.get(selected.taskId);
              if (current && selectedTask && current.taskId !== selectedTask.taskId) {
                const managedBacking = getManagedTaskBackingInstance(current);
                if (
                  !selectedBacking ||
                  !managedBacking ||
                  readManagedTaskBacking(current.detail)?.taskId !== selectedTask.taskId ||
                  !sameTaskBackingInstance(managedBacking, selectedBacking)
                ) {
                  return undefined;
                }
              }
              return current;
            },
            hasAuthoritativeBacking: hasAuthoritativeTaskBacking,
            write: (operation) => operation(),
            beforePersist(receipt) {
              if (receipt.persisted && receipt.becomesTerminal) {
                flushTaskActivity(receipt.task.taskId);
              }
            },
            upsertTask: (task) => tryPersistTaskUpsert(task, "update"),
            deferCommit: (publish) => publish(),
            onCommitted(receipt) {
              publishTaskRecordUpdate(receipt.previous, receipt.task, receipt.persisted);
              if (receipt.deliver) {
                void maybeDeliverTaskStateChangeUpdate(receipt.task, receipt.nextEvent);
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
