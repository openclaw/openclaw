import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import type { TaskMutationContext } from "./task-executor.types.js";
import type { TaskInitialWorkerCommand } from "./task-initial-worker.types.js";
import { captureTaskNotificationTarget } from "./task-notification.operation.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { assertTaskRegistryOwnerCurrent } from "./task-registry-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

type NotificationMutation = Extract<
  TaskInitialWorkerCommand,
  { type: "tasks.acknowledgeStateChange" }
>;
const pendingNotificationMutations = new WeakMap<
  TaskRegistryStore,
  Map<string, Set<Promise<TaskRecord | null>>>
>();

function pendingFor(mutation: TaskMutationContext) {
  return pendingNotificationMutations
    .get(mutation.store)
    ?.get(mutation.context.admission.identity.key);
}

/** Retain the original notification store through transport and mutation settlement. */
export function captureTaskNotificationMutationOwner(assertDeliveryCurrent: () => void) {
  const mutation = captureTaskMutationContext();
  const assertCurrent = () => {
    assertDeliveryCurrent();
    mutation.assertStores();
  };
  const startMutation = (command: NotificationMutation): Promise<TaskRecord | null> => {
    assertCurrent();
    const key = mutation.context.admission.identity.key;
    let byDatabase = pendingNotificationMutations.get(mutation.store);
    if (!byDatabase) {
      byDatabase = new Map();
      pendingNotificationMutations.set(mutation.store, byDatabase);
    }
    let pending = byDatabase.get(key);
    if (!pending) {
      pending = new Set();
      byDatabase.set(key, pending);
    }
    const owned = pending;
    const databases = byDatabase;
    // Register custody before native preparation releases; start storage on the next microtask.
    const operation = Promise.resolve().then(async () => {
      assertCurrent();
      const { settleTaskRecordTransitionAsync } =
        await import("./task-executor-transition.async.js");
      const { receipt } = await settleTaskRecordTransitionAsync(mutation, command, assertCurrent);
      return receipt ? cloneTaskRecord(receipt.task) : null;
    });
    const settlement = operation.finally(() => {
      owned.delete(operation);
      if (owned.size === 0) {
        databases.delete(key);
      }
    });
    owned.add(operation);
    return settlement;
  };
  return {
    async prepare<T>(consume: () => T): Promise<T> {
      assertCurrent();
      for (;;) {
        const pending = pendingFor(mutation);
        if (pending?.size) {
          // Native preparation cannot hold the coordinator while a notification needs host admission.
          await Promise.allSettled(pending);
          assertCurrent();
          continue;
        }
        assertTaskRegistryOwnerCurrent(mutation.context, mutation.store);
        return consume();
      }
    },
    bindStateChange: (task: TaskRecord, eventAt: number) => {
      assertCurrent();
      const input = {
        taskId: task.taskId,
        expectedTask: captureTaskNotificationTarget(task),
        eventAt,
      };
      let acknowledgement: Promise<TaskRecord | null> | undefined;
      return (): Promise<TaskRecord | null> => {
        assertCurrent();
        acknowledgement ??= startMutation({ type: "tasks.acknowledgeStateChange", input });
        return acknowledgement;
      };
    },
  };
}

export async function settleNotificationMutationAfterPreparationFailure(
  pending: Promise<TaskRecord | null> | undefined,
  preparationError: unknown,
): Promise<void> {
  if (!pending) {
    return;
  }
  const [settlement] = await Promise.allSettled([pending]);
  if (settlement.status === "rejected") {
    throw new AggregateError(
      [preparationError, settlement.reason],
      "Task notification preparation and persistence failed",
      { cause: preparationError },
    );
  }
}
