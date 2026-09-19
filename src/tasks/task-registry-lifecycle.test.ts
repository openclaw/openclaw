import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAcpLifecycleStart } from "../agents/command/attempt-execution.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { getTaskActivitySnapshot } from "./task-registry-activity.js";
import {
  reloadTaskRegistryFromStoreAsync,
  runTaskRegistryWorkerMutation,
  tasks,
} from "./task-registry-state.js";
import { findTaskByRunId, getTaskById, markTaskTerminalById } from "./task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import { bindTaskRunOwner } from "./task-run-owner.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
});

describe("task registry agent events", () => {
  it.each([
    { phase: "end", executionSettled: false },
    { phase: "error", executionSettled: false },
    { phase: "end", executionSettled: true },
    { phase: "error", executionSettled: true },
  ])(
    "leaves task settlement to its owner after $phase (execution settled: $executionSettled)",
    async ({ phase, executionSettled }) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const runId = `live-task-${phase}`;
        const task = createTaskFixture("cli", {
          runId,
          childSessionKey: "agent:main:main",
          task: "Work still unwinding",
        });
        const release = bindTaskRunOwner(task, async () => ({
          ok: false,
          error: "Cancellation was not requested.",
        }));
        const execution = () => getTaskExecutionObservation(task).state;
        try {
          emitAgentEvent({
            runId,
            sessionKey: "agent:main:main",
            stream: "lifecycle",
            data: {
              phase,
              status: "cancelled",
              aborted: true,
              stopReason: "rpc",
              endedAt: Date.now(),
              ...(executionSettled ? { executionSettled } : {}),
            },
          });
          expect(getTaskById(task.taskId)).toMatchObject({ status: "running" });
          expect(getTaskById(task.taskId)?.endedAt).toBeUndefined();
          expect(execution()).toBe(executionSettled ? "finished" : "unknown");
          if (executionSettled) {
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: { phase: "start", startedAt: Date.now() },
            });
            expect(execution()).toBe("running");
            emitAgentEvent({ runId, stream: "execution", data: { state: "unknown" } });
            expect(execution()).toBe("unknown");
          }
          markTaskTerminalById({ taskId: task.taskId, status: "cancelled", endedAt: Date.now() });
          expect(getTaskById(task.taskId)?.status).toBe("cancelled");
        } finally {
          release();
        }
      });
    },
  );

  it.each([
    {
      name: "persists an ACP producer timestamp across lifecycle projection and SQLite reload",
      runId: "run-reused-lifecycle",
      task: "Reuse a persisted task row",
      initialStatus: "queued" as const,
      lastEventAt: 1_000,
      lifecycleStartedAt: 2_000,
      terminalStartedAt: undefined,
      endedAt: 2_500,
      expectedStartedAt: 2_000,
    },
    {
      name: "persists an accepted zero lifecycle start timestamp over stale state",
      runId: "run-zero-lifecycle",
      task: "Replace a stale task timestamp",
      initialStatus: "queued" as const,
      lastEventAt: undefined,
      lifecycleStartedAt: 0,
      terminalStartedAt: undefined,
      endedAt: 500,
      expectedStartedAt: 0,
    },
    {
      name: "preserves an earlier nonzero producer timestamp across queued lifecycle writes",
      runId: "run-earlier-lifecycle",
      task: "Normalize the accepted producer timestamp",
      initialStatus: "queued" as const,
      lastEventAt: undefined,
      lifecycleStartedAt: 500,
      terminalStartedAt: undefined,
      endedAt: 1_500,
      expectedStartedAt: 500,
    },
    {
      name: "ignores a non-finite lifecycle timestamp during durable terminal projection",
      runId: "run-non-finite-terminal",
      task: "Keep the accepted producer timestamp",
      initialStatus: undefined,
      lastEventAt: undefined,
      lifecycleStartedAt: undefined,
      terminalStartedAt: Number.NaN,
      endedAt: 1_500,
      expectedStartedAt: 1_000,
    },
  ])(
    "$name",
    async ({
      runId,
      task,
      initialStatus,
      lastEventAt,
      lifecycleStartedAt,
      terminalStartedAt,
      endedAt,
      expectedStartedAt,
    }) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        resetTaskRegistryForTests({ persist: false });
        const created = createTaskFixture("acp", {
          requesterSessionKey: "agent:main:main",
          runId,
          task,
          notifyPolicy: "silent",
          startedAt: 1_000,
          ...(initialStatus === undefined ? {} : { status: initialStatus }),
          ...(lastEventAt === undefined ? {} : { lastEventAt }),
        });

        const published = createDeferred();
        const stop = onTaskRegistryChange(() => {
          if (tasks.get(created.taskId)?.status === "succeeded") {
            published.resolve();
          }
        });
        try {
          if (lifecycleStartedAt !== undefined) {
            emitAcpLifecycleStart({ runId, startedAt: lifecycleStartedAt });
          }
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "end",
              endedAt,
              ...(terminalStartedAt === undefined ? {} : { startedAt: terminalStartedAt }),
            },
          });

          await published.promise;
        } finally {
          stop();
        }

        resetTaskRegistryForTests({ persist: false });
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        expect(getTaskById(created.taskId)).toMatchObject({
          status: "succeeded",
          startedAt: expectedStartedAt,
          endedAt,
        });
      });
    },
  );

  it("keeps unscoped agent events out of SQLite", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-unscoped-events-" },
      async () => {
        createTaskFixture("subagent", {
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:tracked",
          runId: "tracked-run",
          task: "Tracked work",
          status: "running",
          deliveryStatus: "not_applicable",
        });
        const database = openOpenClawStateDatabase();
        const mutation = vi.spyOn(getTaskRegistryStore(), "withMutation");
        const prepare = vi.spyOn(database.db, "prepare");
        const exec = vi.spyOn(database.db, "exec");
        try {
          for (const runId of ["untracked-run", "tracked-run"]) {
            for (const [stream, data] of [
              ["assistant", { delta: "Working" }],
              ["tool", { phase: "start", name: "read" }],
              ["lifecycle", { phase: "end" }],
            ] as const) {
              emitAgentEvent({
                runId,
                sessionKey: "agent:main:subagent:unrelated",
                stream,
                data,
              });
            }
          }
          expect(mutation).not.toHaveBeenCalled();
          expect(prepare).not.toHaveBeenCalled();
          expect(exec).not.toHaveBeenCalled();
        } finally {
          mutation.mockRestore();
          prepare.mockRestore();
          exec.mockRestore();
        }
      },
    );
  });

  it("persists a lifecycle event while a committed worker change awaits reconciliation", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "original-run",
        task: "Follow the committed run",
      });
      const store = getTaskRegistryStore();
      const context = captureOpenClawStateWorkerContext();
      const rebound = { ...task, runId: "rebound-run" };
      const release = createDeferred();
      const pending = runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope: { taskId: task.taskId, runId: rebound.runId },
          publicationRecords: () => new Map([[task.taskId, rebound]]),
        },
        async () => {
          store.upsertTaskWithDeliveryState({ task: rebound });
          await release.promise;
        },
        async () => store.loadSnapshot(),
      );
      const published = createDeferred();
      const stop = onTaskRegistryChange(() => {
        if (tasks.get(task.taskId)?.status === "succeeded") {
          published.resolve();
        }
      });
      try {
        emitAgentEvent({
          runId: rebound.runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
        await published.promise;
        expect(store.loadSnapshot().tasks.get(task.taskId)?.status).toBe("succeeded");
      } finally {
        stop();
        release.resolve();
        await pending;
      }
      expect(getTaskById(task.taskId)?.status).toBe("succeeded");
    });
  });

  it.each(["cli", "subagent"] as const)(
    "bounds durable liveness writes for %s live activity",
    async (runtime) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const store = createInMemoryTaskRegistryStore();
        const upsert = vi.spyOn(store, "upsertTaskWithDeliveryState");
        const mutation = vi.fn();
        store.withMutation = <T>(operation: () => T): T => {
          mutation();
          return operation();
        };
        configureTaskRegistryRuntime({ store });
        const runId = "run-ephemeral-activity";
        const task = createTaskFixture(runtime, {
          childSessionKey: "agent:main:subagent:ephemeral",
          runId,
          task: "Keep streaming state in memory",
        });
        const initialLastEventAt = task.lastEventAt ?? task.createdAt;
        const emit = (stream: string, data: Record<string, unknown>) =>
          emitAgentEvent({ runId, stream, data });
        const emitCandidate = (progressText: string) =>
          emit("item", {
            itemId: "answer-1",
            kind: "answer_candidate",
            title: "Answer candidate",
            phase: "update",
            status: "candidate",
            progressText,
            source: "codex-app-server",
            hideFromChannelProgress: true,
          });
        const dateNow = vi.spyOn(Date, "now").mockReturnValue(initialLastEventAt);
        upsert.mockClear();
        mutation.mockClear();
        try {
          emit("thinking", { text: "Planning" });
          let text = "";
          for (let index = 0; index < 128; index += 1) {
            const delta = `Line ${index + 1}\n`;
            text += delta;
            emitCandidate(text.trimEnd());
            emit("assistant", { text, delta });
          }
          emit("item", {
            itemId: "preamble-1",
            kind: "preamble",
            title: "Preamble",
            phase: "update",
            progressText: "Preparing the next step",
          });
          emit("plan", {
            phase: "update",
            steps: [{ step: "Write the result", status: "in_progress" }],
          });
          emit("usage", { outputTokens: 128 });
          emit("codex_app_server.lifecycle", {
            phase: "thread_ready",
            threadId: "thread-1",
            action: "resumed",
          });
          expect(upsert).not.toHaveBeenCalled();
          expect(mutation).not.toHaveBeenCalled();
          expect(getTaskActivitySnapshot(task.taskId)?.lastActivity).toBe("Line 128");

          dateNow.mockReturnValue(initialLastEventAt + 60_000);
          emitCandidate(text.trimEnd());
          await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
          expect(findTaskByRunId(runId)?.lastEventAt).toBe(initialLastEventAt + 60_000);
          upsert.mockClear();
          emit("assistant", { text: "Still editing" });
          expect(upsert).not.toHaveBeenCalled();
          expect(getTaskActivitySnapshot(task.taskId)?.lastActivity).toBe("Still editing");

          emit("error", { error: "Observed diagnostic failure" });
          await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
          expect(findTaskByRunId(runId)?.error).toBe("Observed diagnostic failure");
          upsert.mockClear();
          emit("tool", {
            phase: "start",
            name: "write",
            toolCallId: "write-1",
            args: { path: "src/example.ts", content: "one\ntwo" },
          });
          await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
          expect(findTaskByRunId(runId)).toMatchObject({
            toolUseCount: 1,
            lastToolName: "write",
          });
          upsert.mockClear();
          emit("tool", {
            phase: "update",
            name: "write",
            toolCallId: "write-1",
            partialResult: { content: [{ type: "text", text: "Writing" }] },
          });
          emit("tool", {
            phase: "result",
            name: "write",
            toolCallId: "write-1",
            isError: false,
          });
          expect(upsert).not.toHaveBeenCalled();
          emit("lifecycle", { phase: "end", endedAt: initialLastEventAt + 60_000 });
          await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
          expect(findTaskByRunId(runId)?.status).toBe("succeeded");
        } finally {
          dateNow.mockRestore();
        }
      });
    },
  );
});
