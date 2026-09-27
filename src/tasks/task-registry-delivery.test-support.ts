import { vi } from "vitest";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { observeAsyncWorkScopeRuns } from "../shared/async-work-scope.test-support.js";
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
  const deliverySignals = new Set<AbortSignal>();
  const scopeRuns = observeAsyncWorkScopeRuns();
  const admit = taskDeliveryAdmission.runTaskDeliveryWithDetachedAdmission;
  const capture = vi
    .spyOn(taskDeliveryAdmission, "runTaskDeliveryWithDetachedAdmission")
    .mockImplementation((taskId, deliver) => {
      const result = admit(taskId, (assertCurrent) => {
        const signal = getAsyncWorkSignal();
        if (signal) {
          deliverySignals.add(signal);
        }
        return deliver(assertCurrent);
      });
      pending.push(result);
      return result;
    });
  return {
    async settleResults() {
      const settled = await Promise.allSettled(pending);
      throwTaskDeliveryFailures(
        settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
    },
    async settle() {
      const failures: unknown[] = [];
      let deliveryPosition = 0;
      let scopePosition = scopeRuns.startIndex;
      do {
        const results = pending.slice(deliveryPosition);
        deliveryPosition = pending.length;
        const settled = await Promise.allSettled(results);
        failures.push(
          ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
        // Admission returns before the enclosing scope drains and releases its root.
        // Only captured delivery scopes belong to this fixture; callers may hold other roots.
        const lifetimes: unknown[] = [];
        while (scopePosition < scopeRuns.mock.results.length) {
          const index = scopePosition++;
          const scope = scopeRuns.mock.contexts[index];
          const result = scopeRuns.mock.results[index]!;
          if (!(scope instanceof AsyncWorkScope) || !deliverySignals.has(scope.signal)) {
            continue;
          }
          if (result.type === "throw") {
            failures.push(result.value);
          } else {
            lifetimes.push(result.value);
          }
        }
        const drained = await Promise.allSettled(lifetimes);
        failures.push(
          ...drained.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      } while (deliveryPosition < pending.length || scopePosition < scopeRuns.mock.results.length);
      throwTaskDeliveryFailures(failures);
    },
    [Symbol.dispose]() {
      capture.mockRestore();
      scopeRuns[Symbol.dispose]();
    },
  };
}

function throwTaskDeliveryFailures(failures: unknown[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Task delivery fixture work failed");
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
