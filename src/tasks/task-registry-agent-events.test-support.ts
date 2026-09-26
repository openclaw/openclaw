import { expect, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { tasks } from "./task-registry-state.js";
import { onTaskRegistryChange } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

export function resetTaskAgentEventTestState(): void {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
}

/** Quiescence only: tests that own rejected read fences or delivery settlement join them separately. */
export async function joinTaskAgentEvents(timeout = 1_000): Promise<void> {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout });
}

/** Capture before emitting; using also retires the listener if an earlier action/assertion fails. */
export function captureTaskPublication(
  taskId: string,
  matches: (task: TaskRecord) => boolean,
  timeoutMs = 5_000,
) {
  const published = createDeferred<{ error: unknown } | null>();
  const check = () => {
    try {
      const current = tasks.get(taskId);
      if (current && matches(current)) {
        stop();
        published.resolve(null);
      }
    } catch (error) {
      stop();
      // Preserve a predicate failure until wait() observes it, even if publication is synchronous.
      published.resolve({ error });
    }
  };
  const stop = onTaskRegistryChange(check);
  check();
  return {
    async wait(): Promise<void> {
      try {
        const failure = await withTestTimeout(
          published.promise,
          timeoutMs,
          `Task ${taskId} did not publish the expected state`,
        );
        if (failure) {
          throw failure.error;
        }
      } finally {
        stop();
      }
    },
    [Symbol.dispose]: stop,
  };
}

export function emitTaskToolStart(runId: string, name: string): void {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name } });
}
