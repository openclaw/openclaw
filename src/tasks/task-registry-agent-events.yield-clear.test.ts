// Proves a non-yield sessions_yield result clears the clue through the event queue.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator as holdCoordinator } from "../test-utils/state-database-contention.js";
import "./task-registry.js";
import {
  captureTaskPublication,
  joinTaskAgentEvents as joinEvents,
  resetTaskAgentEventTestState,
} from "./task-registry-agent-events.test-support.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import { isRetainedYieldOwner } from "./task-retained-yield-guidance.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

afterEach(resetTaskAgentEventTestState);

function readDurableTask(taskId: string) {
  return expectDefined(
    loadTaskRegistryStateFromSqliteReadOnly().tasks.get(taskId),
    `persisted task ${taskId}`,
  );
}

function createRunningToolTask(runId: string, task: string) {
  return createTaskFixture("cli", {
    runId,
    task,
    notifyPolicy: "silent",
  });
}

function queueTool(runId: string, data: AgentEventPayload["data"]) {
  emitAgentEvent({ runId, stream: "tool", data });
}

function emitYield(
  runId: string,
  phase: "start" | "result",
  status?: "deferred" | "yielded" | "error" | "already_pending",
  toolCallId = "yield-1",
) {
  queueTool(
    runId,
    phase === "start"
      ? { phase, name: "sessions_yield", toolCallId }
      : {
          phase,
          name: "sessions_yield",
          toolCallId,
          isError: status === "error",
          ...(status === undefined ? {} : { result: { details: { status } } }),
        },
  );
}

describe("sessions_yield event-queue clearing", () => {
  it.each([false, true])(
    "keeps the current yield across reentrant rotation (explicit: %s)",
    async (explicit) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        // Register before the task listener so the outer event loses its generation in delivery.
        resetTaskRegistryForTests({ persist: false });
        const runId = "yield-reentrant-generation";
        const stop = onAgentEvent((event) => {
          if (event.runId === runId && event.data.name === "older_start") {
            rotateAgentEventLifecycleGeneration();
            emitYield(runId, "start");
          }
        });
        try {
          const task = createRunningToolTask(runId, "Keep the current generation's yield");
          const context = captureOpenClawStateWorkerContext();
          emitAgentEvent({
            runId,
            ...(explicit ? { lifecycleGeneration: getAgentEventLifecycleGeneration() } : {}),
            stream: "tool",
            data: { phase: "start", name: "older_start", toolCallId: "older" },
          });
          // Older queued work may refuse settlement; the nested current call must still persist.
          await Promise.allSettled([captureTaskRegistryReadFence(context.admission)]);
          expect(readDurableTask(task.taskId).lastToolName).toBe("sessions_yield");
          emitYield(runId, "result", "deferred");
          await captureTaskRegistryReadFence(context.admission);
          expect(readDurableTask(task.taskId).lastToolName).toBeUndefined();
        } finally {
          stop();
        }
      });
    },
  );

  it("keeps the current yield call when another database closes", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-other-database", "Retain the exact database owner");
      const context = captureOpenClawStateWorkerContext();
      emitYield(task.runId!, "start");
      await captureTaskRegistryReadFence(context.admission);
      expect(readDurableTask(task.taskId).lastToolName).toBe("sessions_yield");
      const otherPath = path.join(path.dirname(context.admission.databasePath), "other.sqlite");
      openOpenClawStateDatabase({ path: otherPath });
      await closeOpenClawStateDatabaseByPathAsync(otherPath);
      context.admission.assertCurrent();
      emitYield(task.runId!, "result", "deferred");
      await captureTaskRegistryReadFence(context.admission);
      expect(readDurableTask(task.taskId).lastToolName).toBeUndefined();
    });
  });

  it.each([
    ["deferred", false],
    ["error", false],
    ["deferred", true],
  ] as const)(
    "handles a %s result after normalized timestamps (replacement: %s)",
    async (status, replaced) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "yield-normalized-start",
          task: "Clear the exact call after lifecycle timestamp normalization",
          status: "queued",
          startedAt: 1_000,
          notifyPolicy: "silent",
        });
        const context = captureOpenClawStateWorkerContext();
        const holder = holdCoordinator(
          context.admission.databasePath,
          context.coordinatorRuntime,
          10_000,
        );
        try {
          await holder.ready;
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 0 },
          });
          emitYield(task.runId!, "start");
          holder.release();
          await holder.joined;
          await captureTaskRegistryReadFence(context.admission);
          expect(readDurableTask(task.taskId)).toMatchObject({
            createdAt: 0,
            lastToolName: "sessions_yield",
            toolUseCount: 1,
          });

          if (replaced) {
            // Restore the pre-normalization identity, but not the original call's ownership.
            const replacement = {
              ...task,
              status: "running" as const,
              task: "Replacement task",
              lastToolName: "sessions_yield",
              toolUseCount: 1,
            };
            getTaskRegistryStore().upsertTaskWithDeliveryState({ task: replacement });
            publishTaskRecordAfterAtomicStore(replacement);
          }
          emitYield(task.runId!, "result", status);
          await captureTaskRegistryReadFence(context.admission);
          const durable = readDurableTask(task.taskId);
          expect(durable.lastToolName).toBe(replaced ? "sessions_yield" : undefined);
          expect(durable.toolUseCount).toBe(1);
        } finally {
          holder.release();
          await holder.joined;
        }
      });
    },
  );

  it.each([
    { result: "deferred", status: "deferred", clears: true },
    { result: "error", status: "error", clears: true },
    { result: "already_pending", status: "already_pending", clears: true },
    { result: "confirmed yield", status: "yielded", clears: false },
    { result: "missing status", status: undefined, clears: false },
  ] as const)("handles a $result result inside the liveness window", async ({ status, clears }) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask(
        "yield-result-window",
        "Observe the matching yield result",
      );
      using started = captureTaskPublication(
        task.taskId,
        (current) => current.lastToolName === "sessions_yield",
        30_000,
      );
      emitYield(task.runId!, "start");
      await started.wait();
      await joinEvents(30_000);
      expect(readDurableTask(task.taskId).lastToolName).toBe("sessions_yield");
      using cleared = clears
        ? captureTaskPublication(
            task.taskId,
            (current) => current.lastToolName !== "sessions_yield",
            30_000,
          )
        : undefined;
      emitYield(task.runId!, "result", status);
      await cleared?.wait();
      await joinEvents(30_000);
      const durable = readDurableTask(task.taskId);
      expect(durable).toMatchObject({ status: "running", toolUseCount: 1 });
      expect(durable.lastToolName).toBe(clears ? undefined : "sessions_yield");
      expect(Object.hasOwn(durable, "lastToolName")).toBe(!clears);
      expect(isRetainedYieldOwner(durable)).toBe(!clears);
    });
  });

  it.each([
    {
      scenario: "drops a queued yield start when its non-yield result shares that batch",
      queue: (runId: string) => {
        emitYield(runId, "start");
        emitYield(runId, "result", "error");
      },
      lastToolName: undefined,
      toolUseCount: 1,
    },
    {
      scenario: "keeps a newer queued tool start after a non-yield result",
      queue: (runId: string) => {
        emitYield(runId, "start");
        emitYield(runId, "result", "deferred");
        queueTool(runId, { phase: "start", name: "newer_tool" });
      },
      lastToolName: "newer_tool",
      toolUseCount: 2,
    },
    {
      scenario: "does not let a late yield result clear a different queued tool",
      queue: (runId: string) => {
        emitYield(runId, "start");
        queueTool(runId, { phase: "start", name: "newer_tool" });
        emitYield(runId, "result", "deferred");
      },
      lastToolName: "newer_tool",
      toolUseCount: 2,
    },
    {
      scenario: "keeps a newer same-name yield when an older call returns deferred",
      queue: (runId: string) => {
        emitYield(runId, "start", undefined, "older");
        emitYield(runId, "start", undefined, "newer");
        emitYield(runId, "result", "deferred", "older");
        emitYield(runId, "result", "yielded", "newer");
      },
      lastToolName: "sessions_yield",
      toolUseCount: 2,
    },
  ])("$scenario", async ({ queue, lastToolName, toolUseCount }) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-held-sequence", "Preserve queued call ordering");
      const context = captureOpenClawStateWorkerContext();
      const holder = holdCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        10_000,
      );
      try {
        await holder.ready;
        queue(task.runId!);
        expect(Atomics.load(holder.released, 0)).toBe(0);
        const before = readDurableTask(task.taskId);
        expect(before.lastToolName).toBeUndefined();
        expect(before.toolUseCount ?? 0).toBe(0);
        holder.release();
        await holder.joined;
        await joinEvents(30_000);
        const durable = readDurableTask(task.taskId);
        expect(durable.lastToolName).toBe(lastToolName);
        expect(durable.toolUseCount).toBe(toolUseCount);
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("keeps a committed newer yield when the older result arrives later", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-overlap-committed", "Keep a committed newer yield");
      using older = captureTaskPublication(
        task.taskId,
        (current) => current.toolUseCount === 1,
        30_000,
      );
      emitYield(task.runId!, "start", undefined, "older");
      await older.wait();
      await joinEvents(30_000);
      using newer = captureTaskPublication(
        task.taskId,
        (current) => current.toolUseCount === 2,
        30_000,
      );
      emitYield(task.runId!, "start", undefined, "newer");
      await newer.wait();
      await joinEvents(30_000);
      emitYield(task.runId!, "result", "deferred", "older");
      await joinEvents(30_000);
      emitYield(task.runId!, "result", "yielded", "newer");
      await joinEvents(30_000);
      const durable = readDurableTask(task.taskId);
      expect(durable.lastToolName).toBe("sessions_yield");
      expect(durable.toolUseCount).toBe(2);
    });
  });
});
