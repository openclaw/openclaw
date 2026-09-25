import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import type { TaskMutationContext } from "./task-executor.types.js";
import {
  prepareTaskFlowRegistryRead,
  type TaskFlowRegistryRead,
} from "./task-flow-runtime-internal.js";
import type { TaskInitialWorkerCommand } from "./task-initial-worker.types.js";
import {
  captureTaskNotificationTarget,
  type TaskNotificationDeliveryOutcome,
} from "./task-notification.operation.js";
import { prepareTaskRegistryRead, prepareTaskRegistryReadOwner } from "./task-registry-read.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

type NotificationMutation = Extract<
  TaskInitialWorkerCommand,
  { type: "tasks.acknowledgeStateChange" | "tasks.updateNotificationDelivery" }
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
    // Register custody before preparation yields; start storage on the next microtask.
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
    async prepare<T>(
      consume: (flows: TaskFlowRegistryRead, readSubagentRun?: () => SubagentRunRecord | null) => T,
      subagentChildSessionKey?: string,
    ): Promise<T> {
      assertCurrent();
      for (;;) {
        const pending = pendingFor(mutation);
        if (pending?.size) {
          // Notification writes retain the captured store until their publication settles.
          await Promise.allSettled(pending);
          assertCurrent();
          continue;
        }
        const owner = await prepareTaskRegistryReadOwner(mutation.context, mutation.store);
        assertCurrent();
        const read = await prepareTaskRegistryRead(owner);
        assertCurrent();
        const flows = await prepareTaskFlowRegistryRead(mutation.context);
        assertCurrent();
        if (!read || !flows) {
          // Concurrent publication can invalidate the readers' bounded snapshot attempts.
          continue;
        }
        const consumeCurrent = (readSubagentRun?: () => SubagentRunRecord | null) => {
          assertCurrent();
          if (pendingFor(mutation)?.size) {
            return undefined;
          }
          read.assertCurrent();
          flows.assertCurrent();
          return { value: consume(flows, readSubagentRun) };
        };
        let prepared: { value: T } | undefined;
        if (subagentChildSessionKey) {
          const { withPreparedLatestSubagentRunByChildSessionKey } =
            await import("../agents/subagents/registry/subagent-registry-read.js");
          assertCurrent();
          prepared = await withPreparedLatestSubagentRunByChildSessionKey(
            subagentChildSessionKey,
            mutation.context,
            consumeCurrent,
          );
        } else {
          prepared = consumeCurrent();
        }
        if (prepared) {
          return prepared.value;
        }
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
    updateDelivery: (task: TaskRecord, outcome: TaskNotificationDeliveryOutcome) =>
      startMutation({
        type: "tasks.updateNotificationDelivery",
        input: {
          taskId: task.taskId,
          expectedTask: captureTaskNotificationTarget(task),
          ...outcome,
        },
      }),
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
