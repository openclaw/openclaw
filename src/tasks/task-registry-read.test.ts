import { setTimeout as sleep } from "node:timers/promises";
import * as timers from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "../agents/subagents/registry/subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createSubagentsTool } from "../agents/tools/subagents-tool.js";
import {
  createGatewayMethodRegistry,
  createCoreGatewayMethodDescriptors,
} from "../gateway/methods/registry.js";
import { handleGatewayRequest, coreGatewayHandlers } from "../gateway/server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "../gateway/server-methods/types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import {
  createSubagentTaskBackingDetail,
  resolveManagedTaskBackingDetail,
} from "./task-backing-authority.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { createManagedTaskFlow, createTaskFlowForTask } from "./task-flow-registry.js";
import {
  getTaskById,
  listTaskRecordPage,
  listFreshTasksForOwnerKey,
} from "./task-registry-query.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import { tasks, taskProgressBatches } from "./task-registry-state.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("node:timers/promises", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  subagentRuns.clear();
});

async function withReadState(run: () => Promise<void>) {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    try {
      await run();
    } finally {
      const holders = getActiveGatewayRootWorkHolders();
      if (holders.length) {
        console.info("Task read cleanup joining owners:", holders);
      }
      await closeOpenClawStateDatabaseAsync();
      expect(
        getActiveGatewayRootWorkCount(),
        JSON.stringify(getActiveGatewayRootWorkHolders()),
      ).toBe(0);
    }
  });
}

function emitTool(runId: string, name: string) {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name } });
}

function createReadTask(runId: string) {
  return createTaskFixture("cli", {
    runId,
    task: "Read accepted events",
    status: "running",
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
  });
}

function createReadProgressBatch() {
  const entry: SubagentRunRecord = {
    runId: "contended-progress-child",
    childSessionKey: "agent:main:subagent:contended-progress",
    requesterSessionKey: "agent:main:progress-requester",
    requesterAgentId: "main",
    requesterDisplayKey: "progress-requester",
    requesterTurnRunId: "progress-requester-turn",
    requesterTurnYielded: true,
    completionRequesterSessionId: "progress-requester-window",
    task: "Progress under contention",
    cleanup: "keep",
    createdAt: Date.now(),
    generation: 1,
    execution: { status: "running", startedAt: Date.now() },
    expectsCompletionMessage: true,
  };
  subagentRuns.set(entry.runId, entry);
  const origin = { channel: "discord", to: "channel:synthetic-progress" };
  const params = {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    ownerKey: entry.requesterSessionKey,
    requesterAgentId: entry.requesterAgentId,
    task: entry.task,
    notifyPolicy: "state_changes" as const,
    requesterOrigin: origin,
  };
  const canonical = createTaskFixture("subagent", {
    ...params,
    detail: createSubagentTaskBackingDetail(entry.generation!),
  });
  const mirrored = expectDefined(createTaskFlowForTask({ task: canonical }), "canonical task flow");
  expect(linkTaskToFlowById({ taskId: canonical.taskId, flowId: mirrored.flowId })).not.toBeNull();
  const flow = expectDefined(
    createManagedTaskFlow({
      ownerKey: entry.requesterSessionKey,
      controllerId: "tests/read-progress",
      goal: entry.task,
      requesterOrigin: origin,
    }),
    "managed progress flow",
  );
  const managed = createTaskFixture("subagent", {
    ...params,
    parentFlowId: flow.flowId,
    detail: resolveManagedTaskBackingDetail({
      ...params,
      runtime: "subagent",
      scopeKind: "session",
    }),
  });
  expect(
    settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: entry.requesterSessionKey,
      requesterAgentId: entry.requesterAgentId,
      requesterTurnRunId: entry.requesterTurnRunId!,
      requesterYielded: true,
      acceptedSessionSpawns: [
        {
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      progressPresentation: { operationId: "contended-progress-card" },
      runs: subagentRuns,
      persistOrThrow: () => {},
      schedule: () => {},
    }),
  ).toBe(true);
  expect([...taskProgressBatches.values()].some((batch) => batch.members.has(managed.taskId))).toBe(
    true,
  );
}

describe("task registry read preparation", () => {
  it.each(["normalized start", "terminal"] as const)(
    "accepts later events after native %s rollback without an intervening refresh",
    async (phase) => {
      await withReadState(async () => {
        const task = createTaskFixture("cli", {
          runId: `rollback-ingestion-${phase}`,
          task: "Continue after rollback",
          status: phase === "normalized start" ? "queued" : "running",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const failure = new Error("Synthetic rollback before a later event");
        let captured: ReturnType<typeof prepareTaskRegistryRead> | undefined;
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data:
            phase === "normalized start"
              ? { phase: "start", startedAt: task.createdAt - 1_000 }
              : { phase: "end", endedAt: Date.now() },
        });
        expect(() =>
          runOpenClawStateWriteTransaction(() => {
            getTaskById(task.taskId);
            captured = prepareTaskRegistryRead();
            throw failure;
          }),
        ).toThrow(failure);
        emitTool(task.runId!, "after-rollback");
        await expect(expectDefined(captured, "accepted failed batch")).rejects.toBe(failure);
        const read = expectDefined(await prepareTaskRegistryRead(), "read after the new event");
        expect(read.getTaskById(task.taskId)).toMatchObject({
          createdAt: task.createdAt,
          toolUseCount: 1,
          lastToolName: "after-rollback",
        });
      });
    },
  );

  it("wakes an active subagent wait after publication without synchronous writer admission", async () => {
    await withReadState(async () => {
      const task = createReadTask("active-wait-publication");
      const abort = new AbortController();
      const subscribed = createDeferred();
      const addListener = abort.signal.addEventListener.bind(abort.signal);
      vi.spyOn(abort.signal, "addEventListener").mockImplementation((...args) => {
        addListener(...args);
        if (args[0] === "abort") {
          subscribed.resolve();
        }
      });
      const tool = createSubagentsTool({ agentSessionKey: task.ownerKey, config: {} });
      const pending = Promise.resolve(
        tool.execute("wait", { action: "wait", taskIds: [task.taskId] }, abort.signal),
      );
      let mutation: Promise<unknown> | undefined;
      const native = vi.spyOn(getTaskRegistryStore(), "withMutation");
      try {
        await subscribed.promise;
        native.mockClear();
        native.mockImplementation(() => {
          throw new Error("Wait observation acquired synchronous writer custody");
        });
        mutation = createRunningTaskRunCoreWithReceiptAsync({
          runtime: task.runtime,
          runId: task.runId!,
          task: task.task,
          ownerKey: task.ownerKey,
          scopeKind: task.scopeKind,
          requesterSessionKey: task.requesterSessionKey,
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
          detail: { historyGeneration: "replacement" },
        });
        await mutation;
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
        expect(
          (await withTestTimeout(pending, 5_000, "Wait joined its publishing event")).details,
        ).toMatchObject({
          reason: "completed",
          completed: [task.taskId],
        });
        expect(native).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await pending.catch(() => {});
        await mutation;
        native.mockRestore();
      }
    });
  });

  it.each(["list", "wait", "fresh owner"] as const)(
    "keeps %s reads responsive behind accepted events",
    async (surface) => {
      await withReadState(async () => {
        const task = createReadTask(`async-reader-${surface}`);
        emitTool(task.runId!, "warmup");
        await prepareTaskRegistryRead();
        const context = captureOpenClawStateWorkerContext();
        const holder = holdStateDatabaseCoordinator(
          context.admission.databasePath,
          context.coordinatorRuntime,
          300,
        );
        let pending: Promise<unknown> | undefined;
        try {
          await holder.ready;
          const timer = sleep(10).then(() => Atomics.load(holder.released, 0));
          emitTool(task.runId!, "accepted");
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          });
          if (surface === "fresh owner") {
            pending = listFreshTasksForOwnerKey(task.ownerKey);
          } else {
            const tool = createSubagentsTool({ agentSessionKey: task.ownerKey, config: {} });
            pending = Promise.resolve(
              tool.execute("read", { action: surface, taskIds: [task.taskId], timeoutSeconds: 0 }),
            );
          }
          expect(await timer).toBe(0);
          expect(await pending).toMatchObject(
            surface === "fresh owner"
              ? [
                  {
                    taskId: task.taskId,
                    status: "succeeded",
                    toolUseCount: 2,
                    lastToolName: "accepted",
                  },
                ]
              : { details: { tasks: [{ taskId: task.taskId, status: "completed" }] } },
          );
        } finally {
          holder.release();
          await holder.joined;
          await pending;
        }
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          status: "succeeded",
          toolUseCount: 2,
        });
      });
    },
  );

  it("rejects a first-batch selection whose identity changes during a later scan yield", async () => {
    await withReadState(async () => {
      const selected = createReadTask("first-batch-identity");
      for (let index = 0; index < 32; index += 1) {
        createReadTask(`later-batch-${index}`);
      }
      const committed = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const snapshot = store.loadMutationSnapshotAsync.bind(store);
      let held = false;
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const result = await snapshot(...args);
        if (!held && args[1]?.runId === selected.runId) {
          held = true;
          committed.resolve();
          await release.promise;
        }
        return result;
      });
      const immediate = timers.setImmediate;
      vi.mocked(timers.setImmediate).mockImplementationOnce(async (...args) => {
        await immediate(...args);
        await committed.promise;
      });
      let workMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => workMs);
      let mutation: Promise<unknown> | undefined;
      let selectedBeforeMutation = false;
      try {
        const page = await withTestTimeout(
          listTaskRecordPage({
            offset: 0,
            limit: 1,
            prepareFilter: (batch) => {
              workMs += 20;
              if (!mutation) {
                selectedBeforeMutation = batch.some((task) => task.taskId === selected.taskId);
                mutation = createRunningTaskRunCoreWithReceiptAsync({
                  runtime: selected.runtime,
                  runId: selected.runId!,
                  task: selected.task,
                  ownerKey: selected.ownerKey,
                  scopeKind: selected.scopeKind,
                  requesterSessionKey: selected.requesterSessionKey,
                  notifyPolicy: "silent",
                  deliveryStatus: "not_applicable",
                  detail: { historyGeneration: "replacement" },
                });
              }
              return (task) => task.taskId === selected.taskId;
            },
          }),
          5_000,
          "Page joined an identity-changing publication",
        );
        expect(selectedBeforeMutation).toBe(true);
        expect(held).toBe(true);
        expect(page).toEqual({ ok: false, error: "registry_changed" });
      } finally {
        release.resolve();
        await mutation;
      }
    });
  });

  it("does not reacquire writer custody for a second synchronous read of consumed events", async () => {
    await withReadState(async () => {
      const task = createReadTask("consumed-read-custody");
      const admission = vi.spyOn(getTaskRegistryStore(), "withMutation");
      emitTool(task.runId!, "consumed");
      expect(getTaskById(task.taskId)?.toolUseCount).toBe(1);
      const admitted = admission.mock.calls.length;
      expect(getTaskById(task.taskId)?.toolUseCount).toBe(1);
      expect(admission).toHaveBeenCalledTimes(admitted);
      await prepareTaskRegistryRead();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.toolUseCount).toBe(
        1,
      );
    });
  });

  it.each(["idle", "pending events", "active progress"] as const)(
    "keeps registered tasks.list responsive during contention with %s",
    async (scenario) => {
      await withReadState(async () => {
        const pending = scenario !== "idle";
        const task = createReadTask(`registered-read-${scenario}`);
        if (scenario === "active progress") {
          createReadProgressBatch();
        }
        const registry = createGatewayMethodRegistry(
          createCoreGatewayMethodDescriptors(coreGatewayHandlers),
        );
        const client: GatewayClient = {
          connId: "task-read-fixture",
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "test",
              mode: "webchat",
            },
            role: "operator",
            scopes: ["operator.read"],
          },
        };
        const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
        const request = async () => {
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "task-read",
              method: "tasks.list",
              params: { limit: 5, sessionKey: task.ownerKey },
            },
            client,
            context,
            methodRegistry: registry,
            isWebchatConnect: () => false,
            respond,
          });
          return respond;
        };
        emitTool(task.runId!, "warmup");
        await prepareTaskRegistryRead();
        expect((await request()).mock.calls[0]?.[0]).toBe(true);
        const stateContext = captureOpenClawStateWorkerContext();
        const holder = holdStateDatabaseCoordinator(
          stateContext.admission.databasePath,
          stateContext.coordinatorRuntime,
          300,
        );
        let read: ReturnType<typeof request> | undefined;
        try {
          await holder.ready;
          const timer = sleep(10).then(() => Atomics.load(holder.released, 0));
          if (pending) {
            emitTool(task.runId!, "first");
            emitTool(task.runId!, "second");
            emitAgentEvent({
              runId: task.runId!,
              stream: "lifecycle",
              data: { phase: "end", endedAt: Date.now() },
            });
          }
          if (scenario === "active progress") {
            emitAgentEvent({
              runId: "unrelated-requester-start",
              stream: "lifecycle",
              data: { phase: "start", startedAt: Date.now() },
            });
          }
          read = request();
          expect(await timer).toBe(0);
          expect((await read).mock.calls[0]).toMatchObject([
            true,
            {
              tasks: [
                {
                  id: task.taskId,
                  status: pending ? "completed" : "running",
                  toolUseCount: pending ? 3 : 1,
                  lastToolName: pending ? "second" : "warmup",
                },
              ],
            },
          ]);
        } finally {
          holder.release();
          await holder.joined;
          await read;
        }
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          status: pending ? "succeeded" : "running",
          toolUseCount: pending ? 3 : 1,
        });
      });
    },
  );

  it("joins the accepted coalescing batches without waiting for a later terminal event", async () => {
    await withReadState(async () => {
      const task = createReadTask("finite-read-fence");
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const terminalEntered = createDeferred();
      const releaseTerminal = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      let calls = 0;
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        } else if (args[1].change.kind === "terminal") {
          terminalEntered.resolve();
          await releaseTerminal.promise;
        }
        return mutate(...args);
      });
      const published: string[] = [];
      const stop = onTaskRegistryChange(() => {
        const current = tasks.get(task.taskId);
        if (current?.lastToolName) {
          published.push(current.lastToolName);
        }
      });
      try {
        emitTool(task.runId!, "first");
        await firstEntered.promise;
        emitTool(task.runId!, "before-read");
        const prepared = prepareTaskRegistryRead();
        for (let index = 0; index < 20; index += 1) {
          emitTool(task.runId!, `coalesced-${index}`);
        }
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
        releaseFirst.resolve();
        await terminalEntered.promise;
        const read = expectDefined(
          await withTestTimeout(prepared, 5_000, "Read joined a later batch"),
          "prepared task read",
        );
        expect(read.getTaskById(task.taskId)).toMatchObject({
          status: "running",
          toolUseCount: 22,
          lastToolName: "coalesced-19",
        });
        expect(published).toContain("coalesced-19");
        expect(calls).toBe(3);
      } finally {
        releaseFirst.resolve();
        releaseTerminal.resolve();
        await prepareTaskRegistryRead();
        stop();
      }
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
        status: "succeeded",
        toolUseCount: 22,
      });
    });
  });

  it.each(["commit", "rollback"] as const)(
    "settles a native-consumed batch after its outer transaction %s",
    async (outcome) => {
      await withReadState(async () => {
        const task = createReadTask(`native-read-${outcome}`);
        const failure = new Error("Synthetic outer rollback");
        let prepared: ReturnType<typeof prepareTaskRegistryRead> | undefined;
        emitTool(task.runId!, "accepted-native");
        try {
          runOpenClawStateWriteTransaction(() => {
            expect(getTaskById(task.taskId)?.toolUseCount).toBe(1);
            prepared = prepareTaskRegistryRead();
            if (outcome === "rollback") {
              throw failure;
            }
          });
        } catch (error) {
          expect(outcome).toBe("rollback");
          expect(error).toBe(failure);
        }
        const result = expectDefined(prepared, "read captured inside the transaction");
        if (outcome === "rollback") {
          await expect(result).rejects.toBe(failure);
        } else {
          const read = expectDefined(await result, "committed task read");
          expect(read.getTaskById(task.taskId)).toMatchObject({
            toolUseCount: 1,
            lastToolName: "accepted-native",
          });
        }
        expect(
          loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.toolUseCount ?? 0,
        ).toBe(outcome === "commit" ? 1 : 0);
        const fresh = expectDefined(await prepareTaskRegistryRead(), "fresh read after settlement");
        expect(fresh.getTaskById(task.taskId)?.toolUseCount ?? 0).toBe(
          outcome === "commit" ? 1 : 0,
        );
      });
    },
  );

  it.each(["publication", "unknown settlement", "undefined rejection"] as const)(
    "does not acknowledge an accepted batch after %s",
    async (failureKind) => {
      await withReadState(async () => {
        const task = createReadTask(`failed-read-${failureKind}`);
        const earlier = expectDefined(await prepareTaskRegistryRead(), "earlier task read");
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const snapshot = store.loadMutationSnapshotAsync.bind(store);
        const failure =
          failureKind === "undefined rejection"
            ? undefined
            : new SqliteWorkerError(`Synthetic ${failureKind}`, "outcome-unknown");
        const rejection = createDeferred<never>();
        let mutationReturned = false;
        vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
          const result = await mutate(...args);
          mutationReturned = true;
          if (failureKind !== "publication") {
            rejection.reject(failure);
            return rejection.promise;
          }
          return result;
        });
        vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation((...args) => {
          if (failureKind === "publication" && mutationReturned) {
            rejection.reject(failure);
            return rejection.promise;
          }
          return snapshot(...args);
        });
        emitTool(task.runId!, "accepted-failure");
        const read = prepareTaskRegistryRead();
        await expect(read).rejects.toBe(failure);
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          toolUseCount: 1,
          lastToolName: "accepted-failure",
        });
        if (failureKind === "publication") {
          expect(() => earlier.getTaskById(task.taskId)).toThrow("requires preparation");
        }
      });
    },
  );

  it("retires a prepared row reader with its database owner", async () => {
    await withReadState(async () => {
      const task = createReadTask("retired-read");
      const read = expectDefined(await prepareTaskRegistryRead(), "prepared task read");
      expect(read.getTaskById(task.taskId)?.taskId).toBe(task.taskId);
      await closeOpenClawStateDatabaseAsync();
      expect(() => read.getTaskById(task.taskId)).toThrow();
    });
  });
});
