import { vi } from "vitest";
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
      await Promise.all(pending);
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
