import { symlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAcpLifecycleStart } from "../agents/command/acp-lifecycle.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  createSubagentTaskBackingDetail,
  resolveManagedTaskBackingDetail,
} from "./task-backing-authority.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { createTaskFlowForTask } from "./task-flow-registry.js";
import { createManagedTaskFlow } from "./task-flow-registry.test-support.js";
import { getTaskActivitySnapshot } from "./task-registry-activity.js";
import { listTaskRecordPage } from "./task-registry-query.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import {
  readTaskRegistryRevision,
  reloadTaskRegistryFromStoreAsync,
  runTaskRegistryWorkerMutation,
  tasks,
} from "./task-registry-state.js";
import { transitionTaskRecordsByRunAsync } from "./task-registry-transition.async.js";
import { TaskRunTransitionUnsettledError } from "./task-registry-transition.operation.js";
import { findTaskByRunId, getTaskById, markTaskTerminalById } from "./task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";
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
  it.each([false, true])(
    "settles only the selected task and its authoritative managed sibling (flow overload: %s)",
    async (overloaded) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const scope = {
          runId: "selected-completion",
          childSessionKey: "agent:main:subagent:selected",
          ownerKey: "agent:main:main",
        };
        const selected = createTaskFixture("subagent", {
          ...scope,
          task: "Selected canonical task",
          detail: createSubagentTaskBackingDetail(1),
        });
        const mirroredFlow = createTaskFlowForTask({ task: selected });
        if (!mirroredFlow) {
          throw new Error("Expected canonical task flow");
        }
        expect(
          linkTaskToFlowById({ taskId: selected.taskId, flowId: mirroredFlow.flowId }),
        ).not.toBeNull();
        const managedFlow = createManagedTaskFlow({
          ownerKey: scope.ownerKey,
          controllerId: "tests/selected-completion",
          goal: "Track the selected child",
        });
        const managed = createTaskFixture("subagent", {
          ...scope,
          task: "Managed projection of the selected task",
          parentFlowId: managedFlow.flowId,
          detail: resolveManagedTaskBackingDetail({
            ...scope,
            runtime: "subagent",
            scopeKind: "session",
          }),
        });
        const unrelated = createTaskFixture("subagent", {
          ...scope,
          task: "Unrelated task sharing the run scope",
        });

        const transition = {
          kind: "state" as const,
          params: {
            runId: scope.runId,
            runtime: "subagent" as const,
            sessionKey: scope.childSessionKey,
            taskId: selected.taskId,
            status: "succeeded" as const,
            endedAt: Date.now(),
            suppressDelivery: true,
          },
        };
        const store = getTaskRegistryStore();
        let committed: TaskRecord | undefined;
        if (overloaded) {
          const sync = vi
            .spyOn(store, "syncLiveTaskFlowAsync")
            .mockRejectedValue(
              new SqliteWorkerError("Synthetic flow overload after task commit", "overloaded"),
            );
          try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              await expect(transitionTaskRecordsByRunAsync(transition)).rejects.toBeInstanceOf(
                TaskRunTransitionUnsettledError,
              );
              const snapshot = await store.loadMutationSnapshotAsync(
                captureOpenClawStateWorkerContext(),
              );
              committed ??= snapshot.tasks.get(selected.taskId);
              expect(snapshot.tasks.get(selected.taskId)?.status).toBe("succeeded");
              expect(snapshot.tasks.get(managed.taskId)?.status).toBe("running");
            }
          } finally {
            sync.mockRestore();
          }
        }
        const completed = await transitionTaskRecordsByRunAsync(transition);
        expect(completed.map((task) => task.taskId)).toEqual([selected.taskId, managed.taskId]);
        const persisted = await getTaskRegistryStore().loadMutationSnapshotAsync(
          captureOpenClawStateWorkerContext(),
        );
        expect(persisted.tasks.get(selected.taskId)?.status).toBe("succeeded");
        expect(persisted.tasks.get(managed.taskId)?.status).toBe("succeeded");
        expect(persisted.tasks.get(unrelated.taskId)?.status).toBe("running");
        if (committed) {
          expect(persisted.tasks.get(selected.taskId)).toEqual(committed);
        }
      });
    },
  );

  it("settles run completion without entering the main-thread coordinator", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "completion-without-native-wait",
        task: "Synthetic completion",
      });
      const store = getTaskRegistryStore();
      const mutation = vi.spyOn(store, "withMutation");
      const database = openOpenClawStateDatabase();
      const prepare = vi.spyOn(database.db, "prepare");
      const exec = vi.spyOn(database.db, "exec");
      try {
        const completed = await transitionTaskRecordsByRunAsync({
          kind: "state",
          params: {
            runId: task.runId!,
            runtime: task.runtime,
            status: "succeeded",
            endedAt: Date.now(),
            suppressDelivery: true,
          },
        });
        expect(completed).toMatchObject([{ taskId: task.taskId, status: "succeeded" }]);
        expect(mutation).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        const persisted = await store.loadMutationSnapshotAsync(
          captureOpenClawStateWorkerContext(),
          {
            taskId: task.taskId,
          },
        );
        expect(persisted.tasks.get(task.taskId)).toMatchObject({ status: "succeeded" });
      } finally {
        mutation.mockRestore();
        prepare.mockRestore();
        exec.mockRestore();
      }
    });
  });

  it("preserves accepted completion order and refuses revoked queued authority", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "ordered-completion",
        task: "Synthetic ordered completion",
      });
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const worker = vi
        .spyOn(store, "runInitialMutationAsync")
        .mockImplementation(async (...args) => {
          if (args[1].type === "tasks.transitionRunRow") {
            entered.resolve();
            await release.promise;
          }
          return mutate(...args);
        });
      const terminal = {
        runId: task.runId!,
        runtime: task.runtime,
        status: "succeeded" as const,
        endedAt: Date.now(),
        suppressDelivery: true,
      };
      let current = true;
      const first = transitionTaskRecordsByRunAsync({
        kind: "state",
        params: { ...terminal, terminalSummary: "First completion" },
      });
      const second = transitionTaskRecordsByRunAsync(
        { kind: "state", params: { ...terminal, terminalSummary: "Revoked correction" } },
        () => {
          if (!current) {
            throw new Error("Completion authority revoked");
          }
        },
      );
      const settled = Promise.allSettled([first, second]);
      try {
        await entered.promise;
        current = false;
        expect(tasks.get(task.taskId)?.status).toBe("running");
        release.resolve();
        const results = await settled;
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: [{ status: "succeeded", terminalSummary: "First completion" }],
        });
        expect(results[1]).toMatchObject({
          status: "rejected",
          reason: new Error("Completion authority revoked"),
        });
        expect(tasks.get(task.taskId)).toMatchObject({
          status: "succeeded",
          terminalSummary: "First completion",
        });
        expect(worker).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await settled;
        worker.mockRestore();
      }
    });
  });

  it("joins queued run transitions when their database closes before worker admission", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "closing-completion",
        task: "Synthetic closing completion",
      });
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const worker = vi
        .spyOn(store, "runInitialMutationAsync")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return mutate(...args);
        });
      const transition = {
        kind: "state" as const,
        params: {
          runId: task.runId!,
          runtime: task.runtime,
          status: "succeeded" as const,
          endedAt: Date.now(),
          suppressDelivery: true,
        },
      };
      const pending = Promise.allSettled([
        transitionTaskRecordsByRunAsync(transition),
        transitionTaskRecordsByRunAsync(transition),
      ]);
      let closing: Promise<boolean> | undefined;
      let closed = false;
      try {
        await entered.promise;
        const context = captureOpenClawStateWorkerContext();
        closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath).then(
          (result) => {
            closed = true;
            return result;
          },
        );
        expect(() => context.admission.assertCurrent()).toThrow();
        expect(closed).toBe(false);
        release.resolve();
        const results = await pending;
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        await closing;
        expect(worker).toHaveBeenCalledOnce();
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          status: "running",
        });
      } finally {
        release.resolve();
        await pending;
        await closing;
        worker.mockRestore();
      }
    });
  });

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

describe("task registry database lifecycle", () => {
  it.each([false, true])("invalidates only its admitted database (alias: %s)", async (alias) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      const task = createTaskFixture("cli", {
        task: "Keep the selected page current",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      const owner = openOpenClawStateDatabase();
      const unrelated = openOpenClawStateDatabase({ path: state.statePath("identity.sqlite") });
      try {
        if (alias) {
          const aliasRoot = state.path("alias");
          await symlink(state.stateDir, aliasRoot, "junction");
          process.env.OPENCLAW_STATE_DIR = aliasRoot;
        }
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        const page = await listTaskRecordPage({ offset: 0, limit: 1 });
        expect(page.ok).toBe(true);
        if (!page.ok) {
          throw new Error(page.error);
        }
        expect(page.value.tasks.map((record) => record.taskId)).toEqual([task.taskId]);
        const revision = page.value.revision;
        await closeOpenClawStateDatabaseByPathAsync(unrelated.path);
        expect(readTaskRegistryRevision()).toBe(revision);
        expect(page.value.isCurrent()).toBe(true);
        expect(
          await listTaskRecordPage({ offset: 0, limit: 1, expectedRevision: revision }),
        ).toMatchObject({ ok: true, value: { revision } });

        await closeOpenClawStateDatabaseByPathAsync(owner.path);
        expect(readTaskRegistryRevision()).toBeGreaterThan(revision);
        expect(page.value.isCurrent()).toBe(false);
      } finally {
        process.env.OPENCLAW_STATE_DIR = state.stateDir;
      }
    });
  });
});
