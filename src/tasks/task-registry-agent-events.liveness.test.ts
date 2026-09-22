import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { tasks } from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});

function emitTool(runId: string, name: string) {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name } });
}

describe("task agent event liveness", () => {
  it.each([
    { timestamp: "omitted", elapsed: 59_999 },
    { timestamp: "equal", elapsed: 59_999 },
    { timestamp: "omitted", elapsed: 60_000 },
    { timestamp: "equal", elapsed: 60_000 },
  ] as const)(
    "applies the liveness interval to finishing with $timestamp startedAt after $elapsed ms",
    async ({ timestamp, elapsed }) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const startedAt = Date.now() - 1_000;
        const task = createTaskFixture("cli", {
          runId: "finishing-liveness",
          task: "Keep activity transient until its heartbeat",
          startedAt,
          lastEventAt: startedAt,
          notifyPolicy: "silent",
        });
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const entered = createDeferred();
        const release = createDeferred();
        const granted = vi.fn();
        const writes = vi
          .spyOn(store, "runAgentEventMutationAsync")
          .mockImplementation(async (context, input, assertCurrent, onGranted) => {
            entered.resolve();
            await release.promise;
            return mutate(context, input, assertCurrent, (owner) => {
              granted();
              onGranted(owner);
            });
          });
        const published = vi.fn();
        const stop = onTaskRegistryChange(published);
        let fence: Promise<void> | undefined;
        try {
          const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + elapsed);
          try {
            emitAgentEvent({
              runId: task.runId!,
              stream: "lifecycle",
              data: { phase: "finishing", ...(timestamp === "equal" ? { startedAt } : {}) },
            });
          } finally {
            clock.mockRestore();
          }
          await entered.promise;
          let settled = false;
          fence = captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission).then(
            () => {
              settled = true;
            },
          );
          await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
          });
          expect(settled).toBe(false);
          release.resolve();
          await fence;
          const heartbeat = elapsed === 60_000;
          expect(writes).toHaveBeenCalledOnce();
          expect(await writes.mock.results[0]?.value).toEqual(
            heartbeat ? expect.any(Object) : null,
          );
          expect(granted).toHaveBeenCalledTimes(heartbeat ? 1 : 0);
          expect(published).toHaveBeenCalledTimes(heartbeat ? 1 : 0);
          const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          expect(durable).toEqual({
            ...task,
            lastEventAt: heartbeat ? startedAt + elapsed : startedAt,
          });
          expect(tasks.get(task.taskId)).toEqual(durable);
        } finally {
          release.resolve();
          await fence;
          stop();
        }
      });
    },
  );

  it.each([0, 500, 2_000])(
    "persists a changed finite finishing timestamp of %s",
    async (startedAt) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "changed-finishing-start",
          task: "Retain the actual attempt timestamp",
          startedAt: 1_000,
          lastEventAt: Date.now(),
          notifyPolicy: "silent",
        });
        const store = getTaskRegistryStore();
        const writes = vi.spyOn(store, "runAgentEventMutationAsync");
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "finishing", startedAt },
        });
        await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
        expect(writes).toHaveBeenCalledOnce();
        expect(await writes.mock.results[0]?.value).not.toBeNull();
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          status: "running",
          startedAt,
          createdAt: Math.min(task.createdAt, startedAt),
        });
      });
    },
  );

  it.each([100, 200])(
    "compares finishing timestamp %s against the current durable row",
    async (startedAt) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "authoritative-finishing-start",
          task: "Read the current timestamp before comparing",
          startedAt: 100,
          lastEventAt: Date.now(),
          notifyPolicy: "silent",
        });
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const entered = createDeferred();
        const release = createDeferred();
        const writes = vi
          .spyOn(store, "runAgentEventMutationAsync")
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return mutate(...args);
          });
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "finishing", startedAt },
        });
        await entered.promise;
        const fence = captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
        try {
          store.upsertTaskWithDeliveryState({ task: { ...task, startedAt: 200 } });
          expect(tasks.get(task.taskId)?.startedAt).toBe(100);
        } finally {
          release.resolve();
          await fence;
        }
        expect(await writes.mock.results[0]?.value).toEqual(
          startedAt === 200 ? null : expect.any(Object),
        );
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.startedAt).toBe(
          startedAt,
        );
      });
    },
  );

  it.each(["omitted", "equal"] as const)(
    "keeps native read consumption neutral for recent finishing with %s startedAt",
    async (timestamp) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const startedAt = Date.now();
        const task = createTaskFixture("cli", {
          runId: "native-finishing-start",
          task: "Consume activity without making it durable",
          startedAt,
          notifyPolicy: "silent",
        });
        const store = getTaskRegistryStore();
        const writes = vi.spyOn(store, "runAgentEventMutationAsync");
        const published = vi.fn();
        const stop = onTaskRegistryChange(published);
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "finishing", ...(timestamp === "equal" ? { startedAt } : {}) },
          });
          expect(getTaskById(task.taskId)).toEqual(task);
          await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
          expect(writes).not.toHaveBeenCalled();
          expect(published).not.toHaveBeenCalled();
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toEqual(task);
        } finally {
          stop();
        }
      });
    },
  );

  it.each(["omitted", "equal"] as const)(
    "keeps the last explicit lifecycle timestamp when queued finishing is %s",
    async (timestamp) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "coalesced-lifecycle-start",
          task: "Preserve queued lifecycle facts",
          startedAt: 100,
          lastEventAt: Date.now(),
          notifyPolicy: "silent",
        });
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const entered = createDeferred();
        const release = createDeferred();
        const writes = vi
          .spyOn(store, "runAgentEventMutationAsync")
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await release.promise;
            return mutate(...args);
          });
        emitTool(task.runId!, "active");
        await entered.promise;
        let fence: Promise<void> | undefined;
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 200 },
          });
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "finishing", ...(timestamp === "equal" ? { startedAt: 100 } : {}) },
          });
          // Other streams cannot overwrite the lifecycle timestamp while coalescing.
          emitAgentEvent({
            runId: task.runId!,
            stream: "tool",
            data: { phase: "start", name: "queued", startedAt: 300 },
          });
          emitAgentEvent({
            runId: task.runId!,
            stream: "error",
            data: { error: "Latest diagnostic", startedAt: 400 },
          });
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          });
          fence = captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
          release.resolve();
          await fence;
          expect(writes).toHaveBeenCalledTimes(3);
          expect(writes.mock.calls[1]?.[1].change.patch).toMatchObject({
            status: "running",
            startedAt: timestamp === "equal" ? 100 : 200,
            lastToolName: "queued",
            error: "Latest diagnostic",
          });
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
            status: "succeeded",
            startedAt: timestamp === "equal" ? 100 : 200,
            toolUseCount: 2,
            lastToolName: "queued",
            error: "Latest diagnostic",
          });
        } finally {
          release.resolve();
          await fence;
        }
      });
    },
  );
});
