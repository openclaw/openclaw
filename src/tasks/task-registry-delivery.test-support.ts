import { vi } from "vitest";
import * as notificationMutation from "./task-notification-mutation.async.js";
import * as taskDeliveryAdmission from "./task-registry-delivery-admission.js";
import { cloneTaskDeliveryState } from "./task-registry-records.js";
import {
  bumpTaskRegistryRevision,
  taskDeliveryStates,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import { recordTaskRegistryProjectionWrite } from "./task-registry.process-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

/** Fail after a preparation consumer has registered an owned notification write. */
export function failTaskNotificationPreparationAfterConsume(
  shouldFail: () => boolean,
  failure: Error,
): void {
  const capture = notificationMutation.captureTaskNotificationMutationOwner;
  let failed = false;
  vi.spyOn(notificationMutation, "captureTaskNotificationMutationOwner").mockImplementation(
    (assertCurrent) => {
      const owner = capture(assertCurrent);
      return {
        ...owner,
        async prepare<T>(
          consume: Parameters<typeof owner.prepare<T>>[0],
          subagentChildSessionKey?: string,
        ): Promise<T> {
          const result = await owner.prepare(consume, subagentChildSessionKey);
          if (!failed && shouldFail()) {
            failed = true;
            throw failure;
          }
          return result;
        },
      };
    },
  );
}

/** Install a competing delivery commit for notification and projection interleaving controls. */
export function commitTaskDeliveryFixture(state: TaskDeliveryState): void {
  withTaskRegistryMutation(() => {
    const committed = cloneTaskDeliveryState(state);
    getTaskRegistryStore().upsertDeliveryState(committed);
    taskDeliveryStates.set(committed.taskId, committed);
    recordTaskRegistryProjectionWrite("delivery", committed.taskId);
    bumpTaskRegistryRevision();
  });
}

/** Join notifications admitted by synchronous fixture actions before releasing their stores. */
export function captureTaskDeliveryWork() {
  const pending: Array<Promise<TaskRecord | null>> = [];
  const admit = taskDeliveryAdmission.runTaskDeliveryWithDetachedAdmission;
  const capture = vi
    .spyOn(taskDeliveryAdmission, "runTaskDeliveryWithDetachedAdmission")
    .mockImplementation((taskId, deliver) => {
      const result = admit(taskId, deliver);
      pending.push(result);
      return result;
    });
  return {
    async settle() {
      const settled = await Promise.allSettled(pending);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Task delivery fixture work failed");
      }
    },
    [Symbol.dispose]() {
      capture.mockRestore();
    },
  };
}

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  return waitForFast(assertion, { timeout: timeoutMs, interval: stepMs });
}
