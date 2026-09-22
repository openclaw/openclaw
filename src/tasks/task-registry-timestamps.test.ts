import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { setTaskCleanupAfterById, updateTaskStateByRunId } from "./task-registry-record-api.js";
import { readTaskRegistryRevision } from "./task-registry-state.js";
import { finalizeTaskRecordByRunId, getTaskById, markTaskTerminalById } from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { createTaskFixture, withTaskRegistryTempDir } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
});

function requireTaskById(taskId: string): TaskRecord {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Expected task ${taskId}`);
  }
  return task;
}

describe("task registry terminal update timestamps", () => {
  it("persists retention bookkeeping without advancing terminal activity", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("cli", {
        task: "Retained completed work",
        status: "succeeded",
        lastEventAt: 200,
      });
      const published: Array<{ lastEventAt?: number }> = [];
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted" && event.task.taskId === task.taskId) {
              published.push(event.task);
            }
          },
        },
      });
      const cleanupAfter = task.cleanupAfter! + 1_000;
      setTaskCleanupAfterById({ taskId: task.taskId, cleanupAfter });
      const retained = { ...task, cleanupAfter };
      expect(requireTaskById(task.taskId)).toEqual(retained);
      expect(getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId)).toEqual(retained);
      expect(published).toHaveLength(1);
      expect(published[0]?.lastEventAt).toBe(task.lastEventAt);
    });
  });

  it.each([2_000, 2_235])(
    "publishes a newer terminal correction when cancellation occurred at %s",
    async (cancelledAt) => {
      await withTaskRegistryTempDir(async () => {
        const task = createTaskFixture("subagent", {
          childSessionKey: "agent:main:subagent:cancelled-delivery",
          runId: "run-cancelled-delivery",
          task: "Cancel without notifying the stopped parent",
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          startedAt: 1_000,
        });
        markTaskTerminalById({
          taskId: task.taskId,
          status: "cancelled",
          endedAt: 2_235,
          error: SUBAGENT_KILL_TASK_ERROR,
        });
        const provisional = requireTaskById(task.taskId);
        const published: Array<{ lastEventAt?: number; deliveryStatus: string }> = [];
        configureTaskRegistryRuntime({
          observers: {
            onEvent(event) {
              if (event.kind === "upserted" && event.task.taskId === task.taskId) {
                published.push(event.task);
              }
            },
          },
        });
        const finalize = () =>
          finalizeTaskRecordByRunId({
            runId: task.runId!,
            runtime: "subagent",
            status: "cancelled",
            endedAt: cancelledAt,
            lastEventAt: cancelledAt,
            error: "killed",
            suppressDelivery: true,
          });
        finalize();
        const corrected = requireTaskById(task.taskId);
        expect(corrected).toMatchObject({
          status: "cancelled",
          deliveryStatus: "not_applicable",
          endedAt: cancelledAt,
          error: "killed",
          cleanupAfter: provisional.cleanupAfter,
        });
        expect(corrected.lastEventAt).toBeGreaterThan(provisional.lastEventAt!);
        expect(published.at(-1)).toMatchObject({
          lastEventAt: corrected.lastEventAt,
          deliveryStatus: "not_applicable",
        });
        expect(getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId)).toEqual(corrected);
        const revision = readTaskRegistryRevision();
        finalize();
        expect(requireTaskById(task.taskId)).toEqual(corrected);
        expect(readTaskRegistryRevision()).toBe(revision);
      });
    },
  );

  it("records the transition time when a generic update becomes terminal", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("cli", {
        runId: "run-generic-terminal",
        task: "Generic terminal transition",
        status: "running",
        deliveryStatus: "pending",
        lastEventAt: 100,
      });
      updateTaskStateByRunId({ runId: "run-generic-terminal", endedAt: 150 });
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(300);

      updateTaskStateByRunId({ runId: "run-generic-terminal", status: "failed" });
      nowSpy.mockRestore();

      expect(requireTaskById(task.taskId)).toMatchObject({
        status: "failed",
        endedAt: 300,
        deliveryStatus: "session_queued",
        lastEventAt: 301,
      });
    });
  });
});
