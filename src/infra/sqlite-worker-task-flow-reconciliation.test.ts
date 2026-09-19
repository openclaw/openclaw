import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createBackgroundTaskRecord } from "../acp/control-plane/manager.background-task.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import {
  getRuntimeTaskMocks,
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "../plugins/runtime/runtime-task-test-harness.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createAcpTaskBackingDetail } from "../tasks/task-backing-records.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "../tasks/task-executor-create.async.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.test-support.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  deleteTaskFlowRecordById,
  reloadTaskFlowRegistryFromStoreAsync,
} from "../tasks/task-flow-runtime-internal.js";
import {
  cancelTaskById,
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  getTaskById,
  listTaskRecords,
} from "../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "./sqlite-worker-contract.js";
import * as workerStore from "./sqlite-worker-store.js";

const ownerKey = "agent:main:async-reader";
let state: OpenClawTestState;

function task(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: ownerKey,
    ownerKey,
    scopeKind: "session",
    task: "Synthetic task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 100,
    parentFlowId: "flow-a",
    runId: "run-a",
    requesterAgentId: "main",
    ...overrides,
  };
}

function flow(flowId: string, overrides: Partial<TaskFlowRecord> = {}): TaskFlowRecord {
  return {
    flowId,
    syncMode: "managed",
    controllerId: "tests/async-reads",
    ownerKey,
    revision: 1,
    status: "running",
    notifyPolicy: "silent",
    goal: "Synthetic flow",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function observeTaskWorkerReplies(observe: (type: PropertyKey) => Promise<void> | undefined) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
    <Operations extends SqliteWorkerOperations, T>(
      store: SqliteWorkerStore<Operations>,
      operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
      stateContext?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[2],
      assertCurrent?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[3],
      createAdmission?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[4],
      requireStateLifecycle?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[5],
    ) =>
      original(
        store,
        (scope) =>
          operation({
            execute: async (command, options) => {
              const result = await scope.execute(command, options);
              const pending = observe(command.type);
              if (pending) {
                await pending;
              }
              return result;
            },
          }),
        stateContext,
        assertCurrent,
        createAdmission,
        requireStateLifecycle,
      ),
  );
}

function holdFlowWorkerReply(target: "flows.current" | "flows.updateManaged") {
  const held = createDeferredCore();
  const release = createDeferredCore();
  let paused = false;
  observeTaskWorkerReplies((type) => {
    if (!paused && type === target) {
      paused = true;
      held.resolve();
      return release.promise;
    }
    return undefined;
  });
  return { held, release };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-task-async-", applyEnv: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await resetRuntimeTaskTestState();
  await state.cleanup();
});

describe("registered task flow reconciliation", () => {
  it("settles active task fanout through the registered worker without host task or flow writes", async () => {
    installRuntimeTaskDeliveryMock();
    const create = (description: string, childSessionKey = ownerKey) => {
      const parentFlowId = crypto.randomUUID();
      upsertTaskFlowRegistryRecordToSqlite(
        flow(parentFlowId, { syncMode: "task_mirrored", controllerId: undefined }),
      );
      return createRunningTaskRunCoreWithReceiptAsync({
        parentFlowId,
        runtime: "cli",
        ownerKey,
        scopeKind: "session",
        childSessionKey,
        runId: "active-worker-run",
        task: description,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
    };
    const first = await create("First active task");
    const second = await create("Second active task");
    const other = await create("Other active task", "agent:main:other-child");
    if (!first || !second || !other || !first.task.parentFlowId || !second.task.parentFlowId) {
      throw new Error("Expected task and flow receipts");
    }
    const { db } = openOpenClawStateDatabase();
    const sql = getNodeSqliteKysely<DB>(db);
    const tracker = trackSqliteStatementExecutions(db, ["task", "flow"] as const, (statement) => {
      if (!/\b(?:insert|update|delete)\b/i.test(statement)) {
        return null;
      }
      if (/\b(?:task_runs|task_delivery_state)\b/i.test(statement)) {
        return "task";
      }
      return /\bflow_runs\b/i.test(statement) ? "flow" : null;
    });
    const commands: PropertyKey[] = [];
    observeTaskWorkerReplies((type) => {
      commands.push(type);
    });
    try {
      await first.finalizeActive({ status: "succeeded", endedAt: Date.now() }, () => true);
      const stored = executeSqliteQuerySync(
        db,
        sql
          .selectFrom("task_runs")
          .select(["task_id", "status"])
          .where("task_id", "in", [first.task.taskId, second.task.taskId, other.task.taskId]),
      ).rows;
      expect(new Map(stored.map((row) => [row.task_id, row.status]))).toEqual(
        new Map([
          [first.task.taskId, "succeeded"],
          [second.task.taskId, "succeeded"],
          [other.task.taskId, "running"],
        ]),
      );
      const flows = executeSqliteQuerySync(
        db,
        sql
          .selectFrom("flow_runs")
          .select("status")
          .where("flow_id", "in", [first.task.parentFlowId, second.task.parentFlowId]),
      ).rows;
      expect(flows.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
      expect(commands.filter((type) => type === "tasks.finalizeActive")).toHaveLength(2);
      expect(tracker.counts).toEqual({ task: 0, flow: 0 });
    } finally {
      tracker.restore();
    }
  });

  it("publishes only the managed child whose worker receipt has been acknowledged", async () => {
    installRuntimeTaskDeliveryMock();
    upsertTaskFlowRegistryRecordToSqlite(flow("publication-flow"));
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const events: Array<{ taskId: string; task: string }> = [];
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (event.kind === "upserted") {
            events.push({ taskId: event.task.taskId, task: event.task.task });
          }
        },
      },
    });
    const firstRead = createDeferredCore();
    const releaseFirstRead = createDeferredCore();
    const secondReceipt = createDeferredCore();
    const releaseSecondReceipt = createDeferredCore();
    let mutations = 0;
    let readHeld = false;
    observeTaskWorkerReplies((type) => {
      if (type === "flows.runTask" && ++mutations === 2) {
        secondReceipt.resolve();
        return releaseSecondReceipt.promise;
      }
      if (type === "tasks.mutationSnapshot" && !readHeld) {
        readHeld = true;
        firstRead.resolve();
        return releaseFirstRead.promise;
      }
      return undefined;
    });
    const common = {
      flowId: "publication-flow",
      runtime: "cli" as const,
      childSessionKey: "agent:main:publication-child",
      deliveryStatus: "not_applicable" as const,
      notifyPolicy: "silent" as const,
    };
    const pending: Promise<unknown>[] = [];
    try {
      const first = managed.runTask({ ...common, runId: "publication-a", task: "First child" });
      pending.push(first);
      await firstRead.promise;
      const second = managed.runTask({ ...common, runId: "publication-b", task: "Second child" });
      pending.push(second);
      await secondReceipt.promise;
      releaseFirstRead.resolve();
      const firstResult = await first;
      if (!firstResult.created) {
        throw new Error("Expected the first managed child");
      }
      expect(events).toEqual([{ taskId: firstResult.task.taskId, task: "First child" }]);
      releaseSecondReceipt.resolve();
      const secondResult = await second;
      if (!secondResult.created) {
        throw new Error("Expected the second managed child");
      }
      const secondTaskId = secondResult.task.taskId;
      expect(events).toEqual([
        { taskId: firstResult.task.taskId, task: "First child" },
        { taskId: secondTaskId, task: "Second child" },
      ]);
      events.length = 0;
      const reused = await managed.runTask({
        ...common,
        runId: "publication-b",
        task: "Second child",
      });
      if (!reused.created) {
        throw new Error("Expected the existing managed child");
      }
      expect(reused.task.taskId).toBe(secondTaskId);
      expect(events).toEqual([]);
      const updated = await managed.runTask({
        ...common,
        runId: "publication-b",
        task: "Second child",
        sourceId: "publication-source",
      });
      if (!updated.created) {
        throw new Error("Expected the updated managed child");
      }
      expect(updated.task.taskId).toBe(secondTaskId);
      expect(events).toEqual([{ taskId: secondTaskId, task: "Second child" }]);
      expect(getTaskById(secondTaskId)).toMatchObject({
        sourceId: "publication-source",
      });
    } finally {
      releaseFirstRead.resolve();
      releaseSecondReceipt.resolve();
      await Promise.allSettled(pending);
    }
  });

  it.each([4, 16])(
    "keeps ACP creation and managed authority current across %s generations during a worker write",
    async (generations) => {
      installRuntimeTaskDeliveryMock();
      const childSessionKey = "agent:main:history-child";
      const context = {
        agentId: "main",
        requesterAgentId: "main",
        requesterSessionKey: ownerKey,
        childSessionKey,
        runId: "history-run",
        task: "Synthetic task",
      };
      for (let generation = 1; generation <= generations + 3; generation += 1) {
        const id = `history-${generation}`;
        const requesterOnly = generation === generations + 3;
        if (generation !== generations + 2) {
          upsertTaskFlowRegistryRecordToSqlite(
            flow(id, {
              syncMode: generation === generations + 1 ? "managed" : "task_mirrored",
              stateJson: { payload: "雪".repeat(64) },
            }),
          );
        }
        upsertTaskWithDeliveryStateToSqlite({
          task: task(id, {
            agentId: "main",
            runId: context.runId,
            childSessionKey: requesterOnly ? "agent:main:other-child" : childSessionKey,
            requesterSessionKey: requesterOnly ? childSessionKey : ownerKey,
            parentFlowId: id,
            createdAt: generation,
            detail: createAcpTaskBackingDetail(id, requesterOnly ? 1_000 : generation),
          }),
        });
      }
      const measurements: Array<{ phase: string; count: number; rows: number; textBytes: number }> =
        [];
      const measure = async <T>(phase: string, operation: () => T | Promise<T>): Promise<T> => {
        const tracker = trackSqliteStatementExecutions(
          openOpenClawStateDatabase().db,
          ["flows"],
          (sql) =>
            /^\s*select\b/i.test(sql) && /\bfrom\s+"?flow_runs\b/i.test(sql) ? "flows" : null,
        );
        try {
          return await operation();
        } finally {
          measurements.push({
            phase,
            count: tracker.counts.flows,
            rows: tracker.rowCounts.flows,
            textBytes: tracker.textBytes.flows,
          });
          tracker.restore();
        }
      };
      expect(
        await measure("cold-no-eligible", () =>
          createTaskRecord({
            runtime: "cli",
            ownerKey,
            scopeKind: "session",
            task: "Unrelated creation",
            runId: "unrelated-run",
            status: "running",
            deliveryStatus: "not_applicable",
          }),
        ),
      ).toMatchObject({ runtime: "cli", runId: "unrelated-run" });
      const runtime = createPluginRuntime();
      const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
      const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
      const unrelated = await managed.createManaged({
        controllerId: "tests/pending-classification",
        goal: "Unrelated worker write",
      });
      const target = legacy.createManaged({
        controllerId: "tests/backing-projection",
        goal: "Track the current ACP instance",
      });
      if (!target) {
        throw new Error("Expected the managed projection flow");
      }
      const createExisting = () =>
        createTaskRecord({
          runtime: "acp",
          ownerKey,
          scopeKind: "session",
          agentId: "main",
          requesterAgentId: "main",
          requesterSessionKey: ownerKey,
          childSessionKey,
          runId: context.runId,
          task: context.task,
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });
      expect(await measure("clean-create-existing", createExisting)).toMatchObject({
        taskId: "history-1",
        detail: { instanceId: "history-1", generation: 1 },
      });
      const { held, release } = holdFlowWorkerReply("flows.updateManaged");
      const pending = managed.finish({ flowId: unrelated.flowId, expectedRevision: 0 });
      try {
        await held.promise;
        const beforeCount = listTaskRecords().length;
        expect(await measure("pending-create-existing", createExisting)).toMatchObject({
          taskId: "history-1",
          detail: { instanceId: "history-1", generation: 1 },
        });
        expect(listTaskRecords()).toHaveLength(beforeCount);
        const created = await measure("pending-generation-new", () =>
          createBackgroundTaskRecord(context, 2_000, "new-instance"),
        );
        if (!created) {
          throw new Error("Expected the new ACP background task");
        }
        expect(getTaskById(created.taskId)).toMatchObject({
          detail: { instanceId: "new-instance", generation: generations + 1 },
        });
        const reused = await measure("pending-generation-reuse", () =>
          createBackgroundTaskRecord(context, 2_001, "history-1"),
        );
        expect(reused?.taskId).toBe("history-1");
        expect(getTaskById("history-1")?.detail).toEqual(
          createAcpTaskBackingDetail("history-1", 1),
        );
        const project = () =>
          legacy.runTask({
            flowId: target.flowId,
            runtime: "acp",
            childSessionKey,
            agentId: "main",
            runId: context.runId,
            task: "Managed projection",
            status: "running",
          });
        const firstProjection = await measure("pending-project", project);
        if (!firstProjection.created || !firstProjection.task) {
          throw new Error("Expected the first managed ACP projection");
        }
        const firstProjectionTask = firstProjection.task;
        expect(firstProjectionTask.detail).toMatchObject({
          taskId: created.taskId,
          instanceId: "new-instance",
          generation: generations + 1,
        });
        const successor = await measure("pending-generation-successor", () =>
          createBackgroundTaskRecord(context, 2_002, "successor-instance"),
        );
        if (!successor) {
          throw new Error("Expected the successor ACP background task");
        }
        expect(getTaskById(successor.taskId)).toMatchObject({
          detail: { instanceId: "successor-instance", generation: generations + 2 },
        });
        const nextProjection = await measure("pending-project-fresh", project);
        if (!nextProjection.created || !nextProjection.task) {
          throw new Error("Expected the successor managed ACP projection");
        }
        expect(nextProjection.task.taskId).not.toBe(firstProjectionTask.taskId);
        expect(nextProjection.task.detail).toMatchObject({
          taskId: successor.taskId,
          instanceId: "successor-instance",
          generation: generations + 2,
        });
        const currentTask = getTaskById(successor.taskId);
        const staleProjection = getTaskById(firstProjectionTask.taskId);
        expect(
          await measure("pending-stale-authority", () =>
            cancelTaskById({ cfg: {}, taskId: firstProjectionTask.taskId }),
          ),
        ).toMatchObject({
          found: true,
          cancelled: false,
          reason: "Task backing ownership could not be verified.",
        });
        expect(getRuntimeTaskMocks().cancelSessionMock).not.toHaveBeenCalled();
        expect(getTaskById(successor.taskId)).toEqual(currentTask);
        expect(getTaskById(firstProjectionTask.taskId)).toEqual(staleProjection);
        release.resolve();
        expect(await pending).toMatchObject({ applied: true, flow: { status: "succeeded" } });
        const taskIds = [created.taskId, "history-1", successor.taskId, nextProjection.task.taskId];
        const settledTasks = taskIds.map(getTaskById);
        const settledFlow = legacy.get(target.flowId);
        await closeOpenClawStateDatabaseAsync();
        expect(taskIds.map(getTaskById)).toEqual(settledTasks);
        expect(legacy.get(target.flowId)).toEqual(settledFlow);
        expect(legacy.get(unrelated.flowId)).toMatchObject({ revision: 1, status: "succeeded" });
        console.log("ACP creation flow snapshots", JSON.stringify({ generations, measurements }));
        expect(measurements[0]).toMatchObject({ phase: "cold-no-eligible", count: 0, rows: 0 });
        expect(measurements[1]).toMatchObject({
          phase: "clean-create-existing",
          count: 0,
          rows: 0,
        });
        const readBudgets = [2, 6, 7, 6, 6, 6, 2];
        for (const [index, measurement] of measurements.slice(2).entries()) {
          const readBudget = readBudgets[index] ?? 0;
          expect(measurement.count, measurement.phase).toBeGreaterThan(0);
          expect.soft(measurement.count, measurement.phase).toBeLessThanOrEqual(readBudget);
          expect
            .soft(measurement.rows, measurement.phase)
            .toBeLessThanOrEqual(readBudget * (generations + 6));
        }
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(["remove selected", "append candidate"] as const)(
    "preserves ACP generation history when restored observers %s",
    async (change) => {
      const childSessionKey = "agent:main:restore-child";
      for (const [id, generation, createdAt] of [
        ["selected", 100, 1],
        ["retained", 1, 2],
      ] as const) {
        upsertTaskFlowRegistryRecordToSqlite(flow(id, { syncMode: "task_mirrored" }));
        upsertTaskWithDeliveryStateToSqlite({
          task: task(id, {
            childSessionKey,
            parentFlowId: id,
            createdAt,
            detail: createAcpTaskBackingDetail(id, generation),
          }),
        });
      }
      upsertTaskFlowRegistryRecordToSqlite(flow("appended", { syncMode: "task_mirrored" }));
      let observed = false;
      let removed = false;
      let appended: TaskRecord | null = null;
      configureTaskFlowRegistryRuntime({
        observers: {
          onEvent: (event) => {
            if (event.kind !== "restored" || observed) {
              return;
            }
            observed = true;
            if (change === "remove selected") {
              removed = deleteTaskRecordById("selected");
            } else {
              appended = createTaskRecord({
                runtime: "acp",
                ownerKey,
                scopeKind: "session",
                childSessionKey,
                parentFlowId: "appended",
                runId: "appended-run",
                task: "Appended during restore",
                status: "running",
                deliveryStatus: "not_applicable",
                detail: createAcpTaskBackingDetail("appended", 200),
              });
            }
          },
        },
      });
      const created = createBackgroundTaskRecord(
        {
          agentId: "main",
          requesterAgentId: "main",
          requesterSessionKey: ownerKey,
          childSessionKey,
          runId: "after-restore",
          task: "Register after reentrant restore",
        },
        3_000,
        "after-restore-instance",
      );
      expect(observed).toBe(true);
      if (change === "remove selected") {
        expect(removed).toBe(true);
        expect(getTaskById("selected")).toBeUndefined();
      } else {
        expect(appended).toMatchObject({ detail: { generation: 200 } });
      }
      if (!created) {
        throw new Error("Expected ACP creation after reentrant flow restore");
      }
      const expectedGeneration = change === "remove selected" ? 101 : 201;
      expect(getTaskById(created.taskId)).toMatchObject({
        detail: { instanceId: "after-restore-instance", generation: expectedGeneration },
      });
      await closeOpenClawStateDatabaseAsync();
      expect(getTaskById(created.taskId)).toMatchObject({
        detail: { instanceId: "after-restore-instance", generation: expectedGeneration },
      });
    },
  );

  it.each(["read", "lookup", "update", "delete", "refresh"] as const)(
    "does not overwrite a synchronous %s with a delayed worker observation",
    async (intervening) => {
      const lookupReads: Array<{ phase: string; count: number; rows: number; textBytes: number }> =
        [];
      const measureLookup = (phase: string, runId: string, expected: string) => {
        const tracker = trackSqliteStatementExecutions(
          openOpenClawStateDatabase().db,
          ["flows"],
          (sql) =>
            /^\s*select\b/i.test(sql) && /\bfrom\s+"?flow_runs\b/i.test(sql) ? "flows" : null,
        );
        try {
          expect(findTaskByRunId(runId)?.taskId).toBe(expected);
          lookupReads.push({
            phase,
            count: tracker.counts.flows,
            rows: tracker.rowCounts.flows,
            textBytes: tracker.textBytes.flows,
          });
        } finally {
          tracker.restore();
        }
      };
      if (intervening === "lookup") {
        for (let scope = 0; scope < 2; scope += 1) {
          for (let generation = 1; generation <= 18; generation += 1) {
            const id = `lookup-${scope}-${generation}`;
            if (generation !== 18) {
              upsertTaskFlowRegistryRecordToSqlite(
                flow(id, {
                  syncMode: generation === 17 ? "managed" : "task_mirrored",
                  stateJson: { payload: "雪".repeat(64) },
                }),
              );
            }
            upsertTaskWithDeliveryStateToSqlite({
              task: task(id, {
                runId: "lookup-run",
                childSessionKey: `agent:main:lookup-${scope}`,
                parentFlowId: id,
                createdAt: scope * 100 + generation,
                detail: createAcpTaskBackingDetail(id, generation),
              }),
            });
          }
        }
        upsertTaskWithDeliveryStateToSqlite({
          task: task("ineligible", {
            runId: "ineligible-run",
            childSessionKey: "agent:main:ineligible",
          }),
        });
        measureLookup("cold-no-eligible", "ineligible-run", "ineligible");
      }
      const runtime = createPluginRuntime();
      const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
      const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
      const created = await managed.createManaged({
        controllerId: "tests/coexistence",
        goal: "Original flow",
      });
      expect(legacy.get(created.flowId)?.revision).toBe(0);
      if (intervening === "lookup") {
        measureLookup("clean", "lookup-run", "lookup-0-16");
      }
      const tieIds = [
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "00000000-0000-4000-8000-000000000001",
      ] as const;
      if (intervening === "update") {
        const randomId = vi
          .spyOn(crypto, "randomUUID")
          .mockReturnValueOnce(tieIds[0])
          .mockReturnValueOnce(tieIds[1]);
        try {
          legacy.createManaged({
            controllerId: "tests/ties",
            goal: "First inserted",
            createdAt: 100,
          });
          legacy.createManaged({
            controllerId: "tests/ties",
            goal: "Second inserted",
            createdAt: 100,
          });
        } finally {
          randomId.mockRestore();
        }
        expect(
          legacy
            .list()
            .filter((record) => record.controllerId === "tests/ties")
            .map((record) => record.flowId),
        ).toEqual(tieIds);
      }
      const { held, release } = holdFlowWorkerReply(
        intervening === "refresh" ? "flows.current" : "flows.updateManaged",
      );
      const onEvent = vi.fn();
      configureTaskFlowRegistryRuntime({ observers: { onEvent } });
      const pending = managed.finish({ flowId: created.flowId, expectedRevision: 0, endedAt: 100 });
      try {
        await held.promise;
        if (intervening !== "refresh" && intervening !== "lookup") {
          expect(legacy.get(created.flowId)).toMatchObject({ revision: 1, status: "succeeded" });
        }
        if (intervening === "lookup") {
          measureLookup("pending", "lookup-run", "lookup-0-16");
          measureLookup("pending-no-eligible", "ineligible-run", "ineligible");
          const { db } = openOpenClawStateDatabase();
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("flow_runs")
              .set({ sync_mode: "managed" })
              .where("flow_id", "=", "lookup-0-16"),
          );
          measureLookup("pending-fresh", "lookup-run", "lookup-0-15");
        } else if (intervening === "update") {
          expect(
            legacy
              .list()
              .filter((record) => record.controllerId === "tests/ties")
              .map((record) => record.flowId),
          ).toEqual(tieIds);
          expect(
            legacy.resume({ flowId: created.flowId, expectedRevision: 1, status: "running" }),
          ).toMatchObject({ applied: true, flow: { revision: 2, status: "running" } });
        } else if (intervening === "delete") {
          expect(deleteTaskFlowRecordById(created.flowId)).toBe(true);
        } else if (intervening === "refresh") {
          const { db } = openOpenClawStateDatabase();
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("flow_runs")
              .set({ revision: 2, goal: "Refreshed canonical flow" })
              .where("flow_id", "=", created.flowId),
          );
          await reloadTaskFlowRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        }
        onEvent.mockClear();
        release.resolve();
        expect(await pending).toMatchObject({
          applied: true,
          flow: { revision: 1, status: "succeeded" },
        });
        if (intervening === "delete") {
          expect(legacy.get(created.flowId)).toBeUndefined();
        } else {
          const readOnly = intervening === "read" || intervening === "lookup";
          expect(legacy.get(created.flowId)).toMatchObject({
            revision: readOnly ? 1 : 2,
            ...(readOnly || intervening === "update"
              ? { status: readOnly ? "succeeded" : "running" }
              : { goal: "Refreshed canonical flow" }),
          });
        }
        if (intervening === "read" || intervening === "lookup") {
          expect(onEvent).toHaveBeenCalledExactlyOnceWith({
            kind: "upserted",
            flow: expect.objectContaining({ revision: 1, status: "succeeded" }),
            previous: expect.objectContaining({ revision: 0, status: "queued" }),
          });
        } else {
          expect(onEvent).not.toHaveBeenCalled();
        }
        if (intervening === "lookup") {
          measureLookup("settled", "lookup-run", "lookup-0-15");
          const settled = legacy.get(created.flowId);
          await closeOpenClawStateDatabaseAsync();
          measureLookup("reopened", "lookup-run", "lookup-0-15");
          expect(legacy.get(created.flowId)).toEqual(settled);
          console.log("Run lookup flow snapshots", JSON.stringify(lookupReads));
          expect(lookupReads.map(({ count }) => count)).toEqual([0, 0, 1, 0, 1, 0, 1]);
          expect(lookupReads.map(({ rows }) => rows)).toEqual([0, 0, 35, 0, 35, 0, 35]);
          expect(
            lookupReads.filter(({ count }) => count > 0).every(({ textBytes }) => textBytes > 0),
          ).toBe(true);
        }
      } finally {
        release.resolve();
        await pending;
      }
    },
  );
});
