import {
  captureTaskMutationContext,
  type TaskMutationContext,
} from "./task-executor-mutation-effects.async.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { captureTaskStateNotificationTarget } from "./task-state-notification-ack.operation.js";

const pendingAcknowledgements = new WeakMap<
  TaskRegistryStore,
  Map<string, Set<Promise<TaskRecord | null>>>
>();

function pendingFor(mutation: TaskMutationContext) {
  return pendingAcknowledgements.get(mutation.store)?.get(mutation.context.admission.identity.key);
}

/** Capture storage before transport waits; each returned closure owns one sent event. */
export function captureTaskStateNotificationAcknowledger(assertDeliveryCurrent: () => void) {
  const mutation = captureTaskMutationContext();
  const assertCurrent = () => {
    assertDeliveryCurrent();
    mutation.assertStores();
  };
  return {
    async prepare<T>(consume: () => T): Promise<T> {
      assertCurrent();
      for (;;) {
        const pending = pendingFor(mutation);
        if (pending?.size) {
          // Native preparation cannot hold the coordinator while an ACK needs host admission.
          await Promise.allSettled(pending);
          assertCurrent();
          continue;
        }
        // Consume in this frame: a queued event registers its ACK before another prepare runs.
        return consume();
      }
    },
    bind: (task: TaskRecord, eventAt: number) => {
      assertCurrent();
      const input = {
        taskId: task.taskId,
        expectedTask: captureTaskStateNotificationTarget(task),
        eventAt,
      };
      let acknowledgement: Promise<TaskRecord | null> | undefined;
      return (): Promise<TaskRecord | null> => {
        assertCurrent();
        if (acknowledgement) {
          return acknowledgement;
        }
        const key = mutation.context.admission.identity.key;
        let byDatabase = pendingAcknowledgements.get(mutation.store);
        if (!byDatabase) {
          byDatabase = new Map();
          pendingAcknowledgements.set(mutation.store, byDatabase);
        }
        let pending = byDatabase.get(key);
        if (!pending) {
          pending = new Set();
          byDatabase.set(key, pending);
        }
        const owned = pending;
        const databases = byDatabase;
        // Register custody now; start storage after the synchronous queue/send section releases.
        const operation = Promise.resolve().then(async () => {
          assertCurrent();
          const { settleTaskRecordTransitionAsync } =
            await import("./task-executor-transition.async.js");
          const receipt = await settleTaskRecordTransitionAsync(
            mutation,
            { type: "tasks.acknowledgeStateChange", input },
            assertCurrent,
          );
          return receipt ? cloneTaskRecord(receipt.task) : null;
        });
        acknowledgement = operation.finally(() => {
          owned.delete(operation);
          if (owned.size === 0) {
            databases.delete(key);
          }
        });
        owned.add(operation);
        return acknowledgement;
      };
    },
  };
}
