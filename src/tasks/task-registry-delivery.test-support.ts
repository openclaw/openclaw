import { expect, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
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

export async function emitAgentEventAndWaitForTaskDelivery(
  event: Parameters<typeof emitAgentEvent>[0],
) {
  const pending: Array<Promise<TaskRecord | null>> = [];
  const admit = taskDeliveryAdmission.runTaskDeliveryWithDetachedAdmission;
  const capture = vi
    .spyOn(taskDeliveryAdmission, "runTaskDeliveryWithDetachedAdmission")
    .mockImplementation((taskId, deliver) => {
      const result = admit(taskId, deliver);
      pending.push(result);
      return result;
    });
  try {
    emitAgentEvent(event);
    // Row visibility can precede reconciliation; join the notifications the lifecycle started.
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  } finally {
    capture.mockRestore();
  }
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

export async function waitForTaskWork() {
  await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
}
