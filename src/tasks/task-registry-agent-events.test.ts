import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator as holdCoordinator } from "../test-utils/state-database-contention.js";
import { createTaskFlowForTask, readResidentTaskFlow } from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { updateTask } from "./task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { linkTaskToFlowById, markTaskTerminalById } from "./task-registry-record-api.js";
import {
  tasks,
  taskRegistryLog,
  taskFlowSyncOwner,
  runTaskRegistryWorkerMutation,
} from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "./task-registry.store.js";
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

async function joinEvents() {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
}

function taskPublication(
  taskId: string,
  matches: (task: NonNullable<ReturnType<typeof tasks.get>>) => boolean,
) {
  const published = createDeferred();
  const check = () => {
    const current = tasks.get(taskId);
    if (current && matches(current)) {
      published.resolve();
    }
  };
  const stop = onTaskRegistryChange(check);
  check();
  return published.promise.finally(stop);
}

function emitTool(runId: string, name: string) {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name } });
}

describe("task agent event persistence", () => {
  it.each([
    { phase: "start", outcome: "commit" },
    { phase: "start", outcome: "rollback" },
    { phase: "start", outcome: "replacement" },
    { phase: "start", outcome: "ABA" },
    { phase: "start", outcome: "observer ABA" },
    { phase: "end", outcome: "commit" },
    { phase: "end", outcome: "rollback" },
    { phase: "end", outcome: "replacement" },
    { phase: "end", outcome: "ABA" },
    { phase: "end", outcome: "observer ABA" },
  ] as const)(
    "publishes native $phase delivery only after outer $outcome",
    async ({ phase, outcome }) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          requesterSessionKey: "agent:main:main",
          runId: `native-delivery-${phase}-${outcome}`,
          task: "Native commit delivery",
          status: phase === "start" ? "queued" : "running",
          notifyPolicy: phase === "start" ? "state_changes" : "done_only",
          deliveryStatus: "pending",
        });
        const failure = new Error("Synthetic enclosing transaction rollback");
        let observerReplaced = false;
        const stop = onTaskRegistryChange(() => {
          const current = tasks.get(task.taskId);
          if (
            outcome === "observer ABA" &&
            !observerReplaced &&
            current?.status === (phase === "start" ? "running" : "succeeded")
          ) {
            observerReplaced = true;
            updateTask(task.taskId, { ...current, task: "Observer replacement" });
            updateTask(task.taskId, current);
          }
        });
        let consumed: ReturnType<typeof getTaskById>;
        let during: string[] = [];
        let transactionError: unknown;
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data:
            phase === "start"
              ? { phase, startedAt: task.createdAt - 1_000 }
              : { phase, endedAt: Date.now() },
        });
        try {
          runOpenClawStateWriteTransaction(() => {
            consumed = getTaskById(task.taskId);
            during = peekSystemEvents(task.ownerKey);
            if (outcome === "replacement" || outcome === "ABA") {
              updateTask(task.taskId, { task: "Replacement task" });
              if (outcome === "ABA") {
                updateTask(task.taskId, { task: task.task });
              }
            }
            if (outcome === "rollback") {
              throw failure;
            }
          });
        } catch (error) {
          transactionError = error;
        }
        try {
          await joinEvents();
        } finally {
          stop();
        }
        expect(observerReplaced).toBe(outcome === "observer ABA");
        expect(transactionError).toBe(outcome === "rollback" ? failure : undefined);
        const committedStatus = phase === "start" ? "running" : "succeeded";
        expect(consumed?.status).toBe(committedStatus);
        expect(during).toEqual([]);
        const delivered = peekSystemEvents(task.ownerKey);
        expect(delivered).toHaveLength(outcome === "commit" ? 1 : 0);
        if (outcome === "commit") {
          expect(delivered[0]).toContain(task.task);
        }
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.status).toBe(
          outcome === "rollback" ? task.status : committedStatus,
        );
      });
    },
  );

  it.each([
    "ordinary success",
    "synchronous read before result",
    "async refresh before result",
    "sibling readback before result",
    "worker metadata ABA",
    "terminal metadata no-op",
    "native update rollback before result",
    "native update rollback during readback",
    "native update rollback by observer",
    "native update rollback inside committed outer transaction",
    "native update rollback after committed savepoint",
    "native committed ABA before inner rollback",
    "cleanup failure",
    "replacement before readback",
    "replacement by observer",
    "ABA before readback",
  ] as const)("delivers only the current published event across %s", async (scenario) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const nativeRollback = scenario.startsWith("native ");
      const terminal =
        scenario === "cleanup failure" || scenario === "terminal metadata no-op" || nativeRollback;
      const task = createTaskFixture(scenario === "worker metadata ABA" ? "acp" : "cli", {
        requesterSessionKey: "agent:main:main",
        runId: "publication-delivery",
        task: "Original task",
        status: terminal ? "running" : "queued",
        notifyPolicy: terminal ? "done_only" : "state_changes",
        deliveryStatus: "pending",
      });
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      const returned = createDeferred();
      let workerCommitted = false;
      let nativeRolledBack = false;
      const rollBackNativeUpdate = () => {
        const failure = new Error("Synthetic native metadata rollback after worker commit");
        const write = () => {
          expect(updateTask(task.taskId, { task: "Rolled-back task" })).toMatchObject({
            task: "Rolled-back task",
            status: "succeeded",
          });
        };
        const rollback = () => {
          expect(() =>
            runOpenClawStateWriteTransaction(() => {
              if (scenario === "native update rollback after committed savepoint") {
                runOpenClawStateWriteTransaction(write);
              } else {
                write();
              }
              throw failure;
            }),
          ).toThrow(failure);
        };
        if (
          scenario === "native update rollback inside committed outer transaction" ||
          scenario === "native committed ABA before inner rollback"
        ) {
          runOpenClawStateWriteTransaction(() => {
            if (scenario === "native committed ABA before inner rollback") {
              expect(updateTask(task.taskId, { task: "Committed replacement" })).not.toBeNull();
              expect(updateTask(task.taskId, { task: "Original task" })).not.toBeNull();
            }
            rollback();
          });
        } else {
          rollback();
        }
        nativeRolledBack = true;
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          task: "Original task",
          status: "succeeded",
        });
      };
      if (scenario === "native update rollback during readback") {
        const read = store.loadMutationSnapshotAsync.bind(store);
        vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
          const snapshot = await read(...args);
          if (workerCommitted && !nativeRolledBack) {
            rollBackNativeUpdate();
          }
          return snapshot;
        });
      }
      const replace = () => {
        const current = tasks.get(task.taskId)!;
        const next = {
          ...current,
          runId: "replacement-run",
          task: "Replacement task",
          status: "running" as const,
        };
        store.upsertTaskWithDeliveryState({ task: next });
        publishTaskRecordAfterAtomicStore(next);
      };
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
        try {
          const receipt = await mutate(...args);
          workerCommitted = true;
          if (
            nativeRollback &&
            scenario !== "native update rollback during readback" &&
            scenario !== "native update rollback by observer"
          ) {
            rollBackNativeUpdate();
          }
          if (scenario === "synchronous read before result") {
            expect(getTaskById(task.taskId)?.status).toBe("running");
          }
          if (scenario === "async refresh before result") {
            await taskFlowSyncOwner(task.taskId).prepare(
              captureOpenClawStateWorkerContext(),
              store,
              1,
            );
            expect(tasks.get(task.taskId)?.status).toBe("running");
          }
          if (scenario === "sibling readback before result" && receipt) {
            const sibling = {
              ...receipt.task,
              taskId: `${task.taskId}-sibling`,
              task: "Sibling task",
            };
            const context = captureOpenClawStateWorkerContext();
            const scope = { taskId: sibling.taskId, runId: task.runId };
            await runTaskRegistryWorkerMutation(
              {
                admission: context.admission,
                scope,
                publicationRecords: () => new Map([[sibling.taskId, sibling]]),
              },
              async () => store.upsertTaskWithDeliveryState({ task: sibling }),
              () => store.loadMutationSnapshotAsync(context, scope),
            );
          }
          if (
            (scenario === "worker metadata ABA" || scenario === "terminal metadata no-op") &&
            receipt
          ) {
            const context = captureOpenClawStateWorkerContext();
            const scope = { taskId: task.taskId, runId: task.runId };
            for (const text of scenario === "worker metadata ABA"
              ? ["Other writer", task.task]
              : [task.task]) {
              let committed: typeof task | undefined;
              let wrote = false;
              await runTaskRegistryWorkerMutation(
                {
                  admission: context.admission,
                  scope,
                  publicationRecords: () => new Map(committed ? [[task.taskId, committed]] : []),
                  taskRowsWritten: () => wrote,
                },
                async () => {
                  const result = await store.runInitialMutationAsync(
                    context,
                    {
                      type: "tasks.createRecord",
                      input: {
                        taskId: task.taskId,
                        now: Date.now(),
                        params: {
                          runtime: task.runtime,
                          requesterSessionKey: task.requesterSessionKey,
                          ownerKey: task.ownerKey,
                          scopeKind: task.scopeKind,
                          runId: task.runId,
                          task: text,
                          preferMetadata: true,
                          notifyPolicy: task.notifyPolicy,
                          deliveryStatus: task.deliveryStatus,
                        },
                      },
                    },
                    args[2],
                  );
                  expect(result.task.taskId).toBe(task.taskId);
                  expect(result.persisted).toBe(scenario === "worker metadata ABA");
                  committed = result.task;
                  wrote = result.persisted;
                  expect(getTaskById(task.taskId)?.task).toBe(text);
                },
                () => store.loadMutationSnapshotAsync(context, scope),
              );
            }
            expect(tasks.get(task.taskId)).toStrictEqual(receipt.task);
          }
          if (scenario === "ABA before readback" && receipt) {
            for (const record of [{ ...receipt.task, task: "Other writer" }, receipt.task]) {
              store.upsertTaskWithDeliveryState({ task: record });
              publishTaskRecordAfterAtomicStore(record);
            }
          }
          if (scenario === "replacement before readback") {
            replace();
          }
          return scenario === "cleanup failure" && receipt
            ? {
                ...receipt,
                cleanupError: serializeAgentSchemaInspectionError(
                  new Error("Synthetic delivery cleanup failure"),
                ),
              }
            : receipt;
        } finally {
          returned.resolve();
        }
      });
      let replaced = false;
      let observerFailure: unknown;
      const stop = onTaskRegistryChange(() => {
        if (
          scenario === "native update rollback by observer" &&
          !nativeRolledBack &&
          tasks.get(task.taskId)?.status === "succeeded"
        ) {
          nativeRolledBack = true;
          try {
            rollBackNativeUpdate();
          } catch (error) {
            observerFailure = error;
          }
        }
        if (
          scenario === "replacement by observer" &&
          !replaced &&
          tasks.get(task.taskId)?.status === "running"
        ) {
          replaced = true;
          replace();
        }
      });
      try {
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: terminal
            ? { phase: "end", endedAt: Date.now() }
            : { phase: "start", startedAt: Date.now() },
        });
        // A registered task read joins these accepted events, including a publication
        // legitimately replaced after commit. Stale delivery must not poison the read.
        const readResult = Promise.allSettled([prepareTaskRegistryRead()]);
        await returned.promise;
        await joinEvents();
        const [read] = await readResult;
        if (scenario === "cleanup failure") {
          expect(read).toMatchObject({
            status: "rejected",
            reason: expect.objectContaining({ message: "Synthetic delivery cleanup failure" }),
          });
        } else {
          expect(read).toMatchObject({ status: "fulfilled" });
          if (read.status === "fulfilled") {
            expect(read.value?.getTaskById(task.taskId)).toEqual(tasks.get(task.taskId));
          }
        }
        expect(observerFailure).toBeUndefined();
        expect(nativeRolledBack).toBe(nativeRollback);
        const delivered = peekSystemEvents("agent:main:main");
        const shouldDeliver =
          scenario === "ordinary success" ||
          scenario === "cleanup failure" ||
          scenario === "terminal metadata no-op" ||
          (nativeRollback && scenario !== "native committed ABA before inner rollback") ||
          scenario === "synchronous read before result" ||
          scenario === "async refresh before result" ||
          scenario === "sibling readback before result";
        expect(delivered).toHaveLength(shouldDeliver ? 1 : 0);
        if (shouldDeliver) {
          expect(delivered[0]).toContain("Original task");
        }
      } finally {
        stop();
      }
    });
  });

  it.each(["lost result", "unknown settlement", "superseded publication"] as const)(
    "recovers large committed task publication and flow effects after %s without replay",
    async (failureKind) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "committed-recovery",
          task: "Recover the confirmed commit",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
          detail: { payload: "x".repeat(8 * 1024 * 1024) },
        });
        const flow = createTaskFlowForTask({ task });
        expect(flow).not.toBeNull();
        expect(linkTaskToFlowById({ taskId: task.taskId, flowId: flow!.flowId })).not.toBeNull();
        const flowReadback = createDeferred();
        const flowStore = getTaskFlowRegistryStore();
        const readFlow = flowStore.readFlowAsync.bind(flowStore);
        vi.spyOn(flowStore, "readFlowAsync").mockImplementation(async (...args) => {
          const record = await readFlow(...args);
          if (record?.flowId === flow!.flowId && record.status === "succeeded") {
            flowReadback.resolve();
          }
          return record;
        });
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const warned = createDeferred();
        const warning = vi.spyOn(taskRegistryLog, "warn").mockImplementation((message) => {
          if (message === "Task agent event committed before follow-up failed") {
            warned.resolve();
          }
        });
        const writes = vi
          .spyOn(store, "runAgentEventMutationAsync")
          .mockImplementation(async (context, input, assertCurrent, onGranted) => {
            let nativeOwner: SqliteWorkerNativeSettlementOwner | undefined;
            const receipt = await mutate(context, input, assertCurrent, (owner) => {
              nativeOwner = owner;
              onGranted({
                get committed() {
                  return owner.committed;
                },
                get settlement(): SqliteWorkerNativeSettlementOwner["settlement"] {
                  const outcome = owner.settlement;
                  return failureKind === "unknown settlement" && outcome
                    ? { ...outcome, kind: "unknown" }
                    : outcome;
                },
                waitForSettlement(deadlineMs) {
                  if (failureKind === "unknown settlement") {
                    throw new SqliteWorkerError("Synthetic unknown settlement", "outcome-unknown");
                  }
                  return owner.waitForSettlement(deadlineMs);
                },
              });
            });
            expect(JSON.stringify(nativeOwner?.settlement?.committed?.facts).length).toBeLessThan(
              2_000,
            );
            if (failureKind === "superseded publication" && receipt) {
              for (const record of [{ ...receipt.task, task: "Newer row" }, receipt.task]) {
                store.upsertTaskWithDeliveryState({ task: record });
                publishTaskRecordAfterAtomicStore(record);
              }
            }
            throw new SqliteWorkerError(
              "Synthetic lost result after joined commit",
              "outcome-unknown",
            );
          });
        const publications: string[] = [];
        const stop = onTaskRegistryChange(() => {
          const current = tasks.get(task.taskId);
          if (current?.status === "succeeded") {
            publications.push(current.status);
          }
        });
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          });
          await warned.promise;
          await flowReadback.promise;
          await joinEvents();
          expect(writes).toHaveBeenCalledOnce();
          expect(tasks.get(task.taskId)?.status).toBe("succeeded");
          expect(publications).toEqual(
            failureKind === "superseded publication" ? ["succeeded", "succeeded"] : ["succeeded"],
          );
          expect(readResidentTaskFlow(flow!.flowId)?.status).toBe("succeeded");
          expect(flowStore.loadSnapshot().flows.get(flow!.flowId)?.status).toBe("succeeded");
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
            status: "succeeded",
            detail: task.detail,
          });
          expect(warning).toHaveBeenCalledWith(
            "Task agent event committed before follow-up failed",
            expect.objectContaining({ taskId: task.taskId }),
          );
        } finally {
          stop();
        }
      });
    },
  );

  it("bounds queued tool and diagnostic bursts while preserving lifecycle fences and exact counts", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "bounded-events",
        task: "Bounded events",
        status: "queued",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = getTaskRegistryStore();
      const writes = vi.spyOn(store, "runAgentEventMutationAsync");
      const observed: Array<{ status: string; count: number }> = [];
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted" && event.task.taskId === task.taskId) {
              const next = { status: event.task.status, count: event.task.toolUseCount ?? 0 };
              const previous = observed.at(-1) ?? { status: task.status, count: 0 };
              if (next.status !== previous.status || next.count !== previous.count) {
                observed.push(next);
              }
            }
          },
        },
      });
      const terminal = taskPublication(task.taskId, (current) => current.status === "succeeded");
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
          data: { phase: "start", startedAt: Date.now() },
        });
        const payload = "unretained-tool-payload".repeat(50_000);
        for (let index = 0; index < 2_000; index++) {
          emitAgentEvent({
            runId: task.runId!,
            stream: "tool",
            data: { phase: "start", name: `tool-${index}`, args: { payload } },
          });
          emitAgentEvent({
            runId: task.runId!,
            stream: "error",
            data: { error: `diagnostic-${index}`, ignored: payload },
          });
          emitAgentEvent({ runId: task.runId!, stream: "assistant", data: { text: payload } });
        }
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
        emitTool(task.runId!, "after-terminal");
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(Atomics.load(holder.released, 0)).toBe(0);
        holder.release();
        expect(await holder.joined).toBe(0);
        await terminal;
        await joinEvents();
        expect(writes.mock.calls.length).toBeLessThanOrEqual(3);
        expect(writes.mock.calls.every(([, input]) => JSON.stringify(input).length < 2_000)).toBe(
          true,
        );
        expect(observed).toEqual([
          { status: "running", count: 0 },
          { status: "running", count: 2_000 },
          { status: "succeeded", count: 2_000 },
        ]);
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          toolUseCount: 2_000,
          lastToolName: "tool-1999",
          error: "diagnostic-1999",
          status: "succeeded",
        });
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it.each(["end", "error"] as const)(
    "keeps ingestion responsive under cross-thread custody and preserves ordered %s",
    async (phase) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: `contended-${phase}`,
          task: "Ordered events",
          status: "running",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const warmed = taskPublication(task.taskId, (current) => current.toolUseCount === 1);
        emitTool(task.runId!, "warmup");
        await warmed;
        await joinEvents();
        const terminal = taskPublication(
          task.taskId,
          (current) => current.status === (phase === "end" ? "succeeded" : "failed"),
        );
        const context = captureOpenClawStateWorkerContext();
        const { ready, released, joined, release } = holdCoordinator(
          context.admission.databasePath,
          context.coordinatorRuntime,
          300,
        );
        try {
          await ready;
          const timer = sleep(10).then(() => Atomics.load(released, 0));
          emitTool("unmatched-run", "ignored");
          emitTool(task.runId!, "first");
          emitTool(task.runId!, "second");
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: {
              phase,
              endedAt: Date.now(),
              ...(phase === "error" ? { error: "Synthetic failure" } : {}),
            },
          });
          expect(await timer).toBe(0);
          expect(await joined).toBe(0);
          await terminal;
          await joinEvents();
          const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          expect(durable).toMatchObject({
            toolUseCount: 3,
            lastToolName: "second",
            status: phase === "end" ? "succeeded" : "failed",
          });
          if (phase === "error") {
            expect(durable?.error).toBe("Synthetic failure");
          }
          expect(tasks.get(task.taskId)).toEqual(durable);
        } finally {
          release();
          await joined;
        }
      });
    },
  );

  it("retains accepted events across restart admission closure and joins canonical shutdown", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "drained-events",
        task: "Accepted events",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const terminal = taskPublication(task.taskId, (current) => current.status === "succeeded");
      const context = captureOpenClawStateWorkerContext();
      const holder = holdCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        10_000,
      );
      try {
        await holder.ready;
        emitTool(task.runId!, "accepted");
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        });
        markGatewayRestartDraining("restart");
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        holder.release();
        await holder.joined;
        await terminal;
        await joinEvents();
        await closeOpenClawStateDatabaseAsync();
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          toolUseCount: 1,
          status: "succeeded",
        });
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("publishes an acknowledged write while reporting its separate cleanup failure without replay", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "committed-with-cleanup-error",
        task: "Durable outcome",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      const warnings = vi.spyOn(taskRegistryLog, "warn");
      const writes = vi
        .spyOn(store, "runAgentEventMutationAsync")
        .mockImplementation(async (...args) => {
          const receipt = await mutate(...args);
          return (
            receipt && {
              ...receipt,
              cleanupError: serializeAgentSchemaInspectionError(
                new Error("Synthetic postcommit cleanup failure"),
              ),
            }
          );
        });
      const published = taskPublication(task.taskId, (current) => current.toolUseCount === 1);
      emitTool(task.runId!, "committed");
      await published;
      await joinEvents();
      expect(writes).toHaveBeenCalledOnce();
      expect(warnings).toHaveBeenCalledWith(
        "Task agent event committed before follow-up failed",
        expect.objectContaining({
          taskId: task.taskId,
          error: expect.objectContaining({ message: "Synthetic postcommit cleanup failure" }),
        }),
      );
      await closeOpenClawStateDatabaseAsync();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.toolUseCount).toBe(
        1,
      );
    });
  });

  it("releases a native event claim when the scoped projection refresh fails", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "failed-native-refresh",
        task: "Retained event",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      const entered = createDeferred();
      const release = createDeferred();
      const writes = vi
        .spyOn(store, "runAgentEventMutationAsync")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return mutate(...args);
        });
      const published = taskPublication(task.taskId, (current) => current.toolUseCount === 1);
      emitTool(task.runId!, "retained");
      await entered.promise;
      try {
        const refresh = vi.spyOn(store, "loadMutationSnapshot").mockImplementationOnce(() => {
          throw new Error("Synthetic scoped refresh failure");
        });
        try {
          expect(() =>
            markTaskTerminalById({ taskId: task.taskId, status: "cancelled", endedAt: Date.now() }),
          ).toThrow("Synthetic scoped refresh failure");
        } finally {
          refresh.mockRestore();
        }
      } finally {
        release.resolve();
      }
      await published;
      await joinEvents();
      expect(writes).toHaveBeenCalledOnce();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
        toolUseCount: 1,
        lastToolName: "retained",
        status: "running",
      });
    });
  });

  it("consumes queued metadata before a synchronous cancellation without replaying it", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "native-consume",
        task: "Queued cancellation",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      emitTool(task.runId!, "first");
      emitTool(task.runId!, "second");
      expect(
        markTaskTerminalById({ taskId: task.taskId, status: "cancelled", endedAt: Date.now() }),
      ).toMatchObject({ toolUseCount: 2, lastToolName: "second", status: "cancelled" });
      await joinEvents();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
        toolUseCount: 2,
        status: "cancelled",
      });
    });
  });

  it("joins a granted lifecycle write before native finalization consumes its successor events", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "granted-event",
        task: "Granted write",
        status: "queued",
        startedAt: 1_000,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      const finalized = createDeferred();
      let returned = false;
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(
        (context, input, assertCurrent, onGranted) => {
          const operation = mutate(context, input, assertCurrent, (owner) => {
            onGranted(owner);
            if (input.change.kind !== "start") {
              return;
            }
            try {
              expect(returned).toBe(false);
              expect(
                markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 }),
              ).toMatchObject({
                toolUseCount: 1,
                lastToolName: "held",
                status: "succeeded",
                createdAt: 0,
                startedAt: 0,
              });
              finalized.resolve();
            } catch (error) {
              finalized.reject(error);
            }
          });
          return operation.finally(() => {
            returned = true;
          });
        },
      );
      emitAgentEvent({
        runId: task.runId!,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 0 },
      });
      emitTool(task.runId!, "held");
      emitAgentEvent({
        runId: task.runId!,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 2_000 },
      });
      await finalized.promise;
      await joinEvents();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
        toolUseCount: 1,
        status: "succeeded",
        createdAt: 0,
        startedAt: 0,
      });
    });
  });

  it.each(["task replacement", "lifecycle rotation"] as const)(
    "rejects captured event work after %s",
    async (replacement) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "retired-event",
          task: "Retired owner",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const store = getTaskRegistryStore();
        const mutate = store.runAgentEventMutationAsync.bind(store);
        const entered = createDeferred();
        const release = createDeferred();
        vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return mutate(...args);
        });
        emitTool(task.runId!, "stale");
        await entered.promise;
        let fence: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          fence = Promise.allSettled([
            captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission),
          ]);
          if (replacement === "task replacement") {
            const next = { ...task, runId: "replacement-run" };
            store.upsertTaskWithDeliveryState({ task: next });
            publishTaskRecordAfterAtomicStore(next);
          } else {
            rotateAgentEventLifecycleGeneration();
          }
        } finally {
          release.resolve();
          await fence;
        }
        await joinEvents();
        expect(
          loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.toolUseCount ?? 0,
        ).toBe(0);
      });
    },
  );
});
