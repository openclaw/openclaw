import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskRegistryStore,
  createInMemoryTaskFlowRegistryStore,
  reconcileTaskFlowRestoreForTests,
} from "../test-utils/task-registry-store.js";
import { ensureTaskRuntimeStateReady } from "./runtime-internal.js";
import { createAcpTaskBackingDetail } from "./task-backing-records.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  reloadTaskFlowRegistryFromStoreAsync,
  runTaskFlowRegistryWorkerMutation,
  getTaskFlowById,
  readResidentTaskFlow,
  setFlowWaiting,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { commitTaskDeliveryFixture } from "./task-registry-delivery.test-support.js";
import { getTaskDeliveryState } from "./task-registry-mutation.js";
import type { TaskRegistryRestoreResult } from "./task-registry-restore.worker.js";
import {
  ensureTaskRegistryReadyAsync,
  reloadTaskRegistryFromStoreAsync,
  tasks,
  tasksWithPendingDelivery,
} from "./task-registry-state.js";
import {
  getTaskById,
  listTasksForOwnerKey,
  findTaskByRunId,
  updateTaskNotifyPolicyById,
  deleteTaskRecordById,
} from "./task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  type TaskRegistryStoreSnapshot,
} from "./task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

const ownerKey = "agent:main:restore";
const task: TaskRecord = {
  taskId: "restored-task",
  runtime: "cli",
  requesterSessionKey: ownerKey,
  ownerKey,
  scopeKind: "session",
  task: "Synthetic restore",
  status: "running",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 10,
  runId: "restored-run",
};
const flow: TaskFlowRecord = {
  flowId: "restored-flow",
  syncMode: "managed",
  controllerId: "tests/restore",
  ownerKey,
  goal: "Synthetic flow",
  revision: 0,
  status: "running",
  notifyPolicy: "silent",
  createdAt: 10,
  updatedAt: 10,
};
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "registry-async-restore-",
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  await state.cleanup();
});

function taskStore() {
  return createInMemoryTaskRegistryStore({
    tasks: new Map([[task.taskId, task]]),
    deliveryStates: new Map([[task.taskId, { taskId: task.taskId, lastNotifiedEventAt: 12 }]]),
  });
}

function taskRestoreResult(snapshot: TaskRegistryStoreSnapshot): TaskRegistryRestoreResult {
  return { snapshot, settledTasks: [], flowSyncs: [] };
}

function identityRestoreFixture(kind: "task" | "flow", options?: { sameIdentity?: boolean }) {
  const captured = captureOpenClawStateWorkerContext();
  const contextFor = (key: string): OpenClawStateWorkerContext => ({
    ...captured,
    admission: {
      ...captured.admission,
      identity: { ...captured.admission.identity, key },
    },
  });
  const first = contextFor("first");
  const second = contextFor(options?.sameIdentity ? "first" : "second");
  let current = first;
  vi.spyOn(stateDatabaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementation(
    () => current.admission,
  );
  vi.spyOn(
    stateDatabaseCache.openClawStateDatabaseCache,
    "getKnownOpenClawStateDatabaseIdentity",
  ).mockImplementation(() => current.admission.identity);
  const loads: string[] = [];
  const observed: string[] = [];
  let beforeSnapshot = async (_context: OpenClawStateWorkerContext) => {};
  const selected = (context: OpenClawStateWorkerContext) =>
    context === first ? "first" : "second";
  const stores = {
    task: (context: OpenClawStateWorkerContext) =>
      createInMemoryTaskRegistryStore({
        tasks: new Map([[task.taskId, { ...task, task: selected(context) }]]),
        deliveryStates: new Map(),
      }),
    flow: (context: OpenClawStateWorkerContext) =>
      createInMemoryTaskFlowRegistryStore({
        flows: new Map([[flow.flowId, { ...flow, goal: selected(context) }]]),
      }),
  };
  if (kind === "task") {
    configureTaskRegistryRuntime({
      store: {
        ...stores.task(first),
        loadSnapshot: () => stores.task(current).loadSnapshot(),
        async withSnapshotAsync(context, consume) {
          loads.push(selected(context));
          await beforeSnapshot(context);
          return consume(taskRestoreResult(stores.task(context).loadSnapshot()), async () => {});
        },
      },
      observers: {
        onEvent: (event) => {
          if (event.kind === "restored") {
            observed.push(getTaskById(task.taskId)?.task ?? "missing");
          }
        },
      },
    });
  } else {
    configureTaskFlowRegistryRuntime({
      store: {
        ...stores.flow(first),
        loadSnapshot: () => stores.flow(current).loadSnapshot(),
        async withSnapshotAsync(context, consume) {
          loads.push(selected(context));
          await beforeSnapshot(context);
          return consume(stores.flow(context).loadSnapshot());
        },
      },
    });
  }
  return {
    first,
    second,
    loads,
    observed,
    select(context: OpenClawStateWorkerContext) {
      current = context;
    },
    beforeSnapshot(callback: typeof beforeSnapshot) {
      beforeSnapshot = callback;
    },
    ensure: kind === "task" ? ensureTaskRegistryReadyAsync : ensureTaskFlowRegistryReadyAsync,
    reload:
      kind === "task" ? reloadTaskRegistryFromStoreAsync : reloadTaskFlowRegistryFromStoreAsync,
    read: () =>
      kind === "task" ? getTaskById(task.taskId)?.task : getTaskFlowById(flow.flowId)?.goal,
    readResident: () =>
      kind === "task" ? tasks.get(task.taskId)?.task : readResidentTaskFlow(flow.flowId)?.goal,
  };
}

describe("asynchronous registry restoration", () => {
  it.each(["native", "worker"] as const)(
    "leaves legacy task identifiers to Doctor during %s hydration, including after database close",
    async (mode) => {
      const runId = ` \t${task.runId}\n`;
      const childSessionKey = "\u00a0agent:main:legacy-child\u00a0";
      upsertTaskWithDeliveryStateToSqlite({
        task,
        deliveryState: { taskId: task.taskId, lastNotifiedEventAt: 12 },
      });
      const { db } = openOpenClawStateDatabase();
      db.prepare("UPDATE task_runs SET run_id = ?, child_session_key = ? WHERE task_id = ?").run(
        runId,
        childSessionKey,
        task.taskId,
      );
      const readRows = () => {
        const { db: current } = openOpenClawStateDatabase();
        return {
          tasks: current.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
          delivery: current.prepare("SELECT * FROM task_delivery_state ORDER BY task_id").all(),
        };
      };
      const before = readRows();
      for (let generation = 0; generation < 2; generation += 1) {
        await closeOpenClawStateDatabaseAsync();
        if (mode === "worker") {
          await ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
        }
        expect(getTaskById(task.taskId)).toMatchObject({ runId, childSessionKey });
        expect(readRows()).toEqual(before);
      }
    },
  );

  it("reads one complete flow snapshot for a synchronous run lookup after close", async () => {
    upsertTaskFlowRegistryRecordToSqlite({
      ...flow,
      syncMode: "task_mirrored",
      controllerId: undefined,
      status: "succeeded",
      endedAt: 20,
    });
    upsertTaskWithDeliveryStateToSqlite({
      task: {
        ...task,
        runtime: "acp",
        childSessionKey: "agent:main:restored-child",
        parentFlowId: flow.flowId,
        detail: createAcpTaskBackingDetail("restored-instance", 1),
        status: "succeeded",
        endedAt: 20,
      },
    });
    expect(findTaskByRunId("restored-run")?.taskId).toBe(task.taskId);
    await closeOpenClawStateDatabaseAsync();
    const tracker = trackSqliteStatementExecutions(
      openOpenClawStateDatabase().db,
      ["flows"],
      (sql) => (/^\s*select\b/i.test(sql) && /\bfrom\s+"?flow_runs\b/i.test(sql) ? "flows" : null),
    );
    try {
      expect(findTaskByRunId("restored-run")?.taskId).toBe(task.taskId);
      expect(tracker.counts.flows).toBe(1);
      expect(tracker.rowCounts.flows).toBe(1);
    } finally {
      tracker.restore();
    }
  });

  it("refreshes a pending flow write after synchronous snapshot installation", async () => {
    const store = createInMemoryTaskFlowRegistryStore({ flows: new Map([[flow.flowId, flow]]) });
    const loadSnapshot = vi.fn(store.loadSnapshot);
    const release = createDeferred();
    const context = captureOpenClawStateWorkerContext();
    configureTaskFlowRegistryRuntime({
      store: { ...store, loadSnapshot },
    });
    const pending = runTaskFlowRegistryWorkerMutation(
      { flowId: flow.flowId, admission: context.admission },
      async () => {
        store.upsertFlow({ ...flow, revision: 1, currentStep: "pending mutation" });
        await release.promise;
      },
      () => store.readFlowAsync(context, flow.flowId),
    );
    try {
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        revision: 1,
        currentStep: "pending mutation",
      });
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
      expect(loadSnapshot).toHaveBeenNthCalledWith(1);
      expect(loadSnapshot).toHaveBeenNthCalledWith(2, [flow.flowId]);
    } finally {
      release.resolve();
      await pending;
    }
    expect(getTaskFlowById(flow.flowId)?.revision).toBe(1);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("restores complete task and flow state before observers without parent SQLite through close", async () => {
    upsertTaskFlowRegistryRecordToSqlite({ ...flow, flowId: "flow-a", stateJson: { cursor: 3 } });
    upsertTaskWithDeliveryStateToSqlite({
      task: { ...task, taskId: "retained", parentFlowId: "flow-a" },
      deliveryState: { taskId: "retained", lastNotifiedEventAt: 50 },
    });
    for (const [flowId, revision, stale] of [
      ["legacy-mirror", 7, false],
      ["stale-mirror", 9, true],
    ] as const) {
      upsertTaskFlowRegistryRecordToSqlite({
        ...flow,
        flowId,
        syncMode: "task_mirrored",
        controllerId: undefined,
        goal: task.task,
        status: stale ? "running" : "succeeded",
        revision,
        updatedAt: stale ? 10 : 20,
        ...(stale ? { waitJson: { pending: true } } : { endedAt: 20 }),
      });
      upsertTaskWithDeliveryStateToSqlite({
        task: { ...task, taskId: flowId, parentFlowId: flowId, status: "succeeded", endedAt: 20 },
      });
    }
    closeOpenClawStateDatabase();
    const restored: string[] = [];
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (event.kind === "restored") {
            restored.push(
              `${getTaskById("retained")?.taskId}:${getTaskFlowById("flow-a")?.flowId}`,
            );
          }
        },
      },
    });
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    await ensureTaskRuntimeStateReady();
    expect(restored).toEqual(["retained:flow-a"]);
    expect(getTaskDeliveryState("retained")?.lastNotifiedEventAt).toBe(50);
    expect(getTaskFlowById("flow-a")?.stateJson).toEqual({ cursor: 3 });
    expect(getTaskById("retained")?.runId).toBe(task.runId);
    const context = captureOpenClawStateWorkerContext();
    for (const [flowId, expectedRevision] of [
      ["legacy-mirror", 7],
      ["stale-mirror", 10],
    ] as const) {
      for (let replay = 0; replay < 2; replay += 1) {
        const synced = await getTaskRegistryStore().syncTaskFlowAsync(context, { taskId: flowId });
        expect(synced).toMatchObject({
          kind: "result",
          result: { ok: true, flow: { status: "succeeded", revision: expectedRevision } },
        });
        const persisted = await getTaskFlowRegistryStore().readFlowAsync(context, flowId);
        expect(persisted).toMatchObject({
          status: "succeeded",
          revision: expectedRevision,
          endedAt: 20,
        });
        expect(persisted?.waitJson).toBe(flowId === "legacy-mirror" ? undefined : null);
      }
    }
    await closeOpenClawStateDatabaseAsync();
    sql.expectIdle();
  });

  it("preserves flow preparation failure when task publication loses admission", async () => {
    const store = taskStore();
    const started = createDeferred();
    const release = createDeferred();
    const operationError = new SqliteWorkerError(
      "Synthetic flow preparation failed",
      "outcome-unknown",
    );
    const retirementError = new Error("Synthetic task publication admission retired");
    const context = captureOpenClawStateWorkerContext();
    const observed: string[] = [];
    let loads = 0;
    configureTaskFlowRegistryRuntime({
      store: {
        ...createInMemoryTaskFlowRegistryStore({ flows: new Map() }),
        async withSnapshotAsync() {
          started.resolve();
          await release.promise;
          throw operationError;
        },
      },
    });
    configureTaskRegistryRuntime({
      store: {
        ...store,
        async withSnapshotAsync(_context, consume) {
          loads += 1;
          return consume(
            {
              ...taskRestoreResult(store.loadSnapshot()),
              flowSyncs: [
                {
                  taskId: task.taskId,
                  flowId: flow.flowId,
                  kind: "result",
                  result: { ok: true, flow },
                },
              ],
            },
            () => reconcileTaskFlowRestoreForTests(context, [flow.flowId]),
          );
        },
      },
      observers: { onEvent: (event) => observed.push(event.kind) },
    });
    const first = ensureTaskRegistryReadyAsync(context);
    await started.promise;
    const second = ensureTaskRegistryReadyAsync(context);
    const settled = Promise.allSettled([first, second]);
    vi.spyOn(context.admission, "assertCurrent").mockImplementation(() => {
      throw retirementError;
    });
    release.resolve();
    const results = await settled;
    expect(loads).toBe(1);
    expect(observed).toEqual([]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error("Retired task publication unexpectedly succeeded");
      }
      expect(result.reason).toBeInstanceOf(AggregateError);
      expect(result.reason.cause).toBeInstanceOf(AggregateError);
      expect(result.reason.cause.cause).toBe(operationError);
      expect(result.reason.cause.errors).toEqual([operationError, retirementError]);
      expect(result.reason.errors).toEqual([result.reason.cause, retirementError]);
    }
  });

  it("coalesces restoration through current flow reconciliation before observers without clearing delivery work", async () => {
    const store = taskStore();
    const flowStore = createInMemoryTaskFlowRegistryStore({
      flows: new Map([[flow.flowId, flow]]),
    });
    const started = createDeferred();
    const release = createDeferred();
    const readingFlow = createDeferred();
    const releaseFlow = createDeferred();
    let loads = 0;
    const observed: string[] = [];
    const context = captureOpenClawStateWorkerContext();
    configureTaskFlowRegistryRuntime({
      store: {
        ...flowStore,
        async readFlowAsync(current, flowId) {
          readingFlow.resolve();
          await releaseFlow.promise;
          return flowStore.readFlowAsync(current, flowId);
        },
      },
    });
    await ensureTaskFlowRegistryReadyAsync(context);
    flowStore.upsertFlow({ ...flow, revision: 2, currentStep: "newer durable state" });
    configureTaskRegistryRuntime({
      store: {
        ...store,
        loadSnapshot: () => {
          throw new Error("unexpected synchronous restore");
        },
        withSnapshotAsync: async (_context, consume) => {
          loads += 1;
          started.resolve();
          await release.promise;
          return consume(
            {
              ...taskRestoreResult(store.loadSnapshot()),
              flowSyncs: [
                {
                  taskId: task.taskId,
                  flowId: flow.flowId,
                  kind: "result",
                  result: { ok: true, flow: { ...flow, revision: 1 } },
                },
              ],
            },
            () => reconcileTaskFlowRestoreForTests(context, [flow.flowId]),
          );
        },
      },
      observers: {
        onEvent(event) {
          if (event.kind === "restored") {
            observed.push(
              `${findTaskByRunId("restored-run")?.taskId}:${getTaskFlowById(flow.flowId)?.revision}`,
            );
          }
        },
      },
    });
    tasksWithPendingDelivery.set(task.taskId, Symbol("test delivery claim"));
    const first = ensureTaskRegistryReadyAsync(context);
    const second = ensureTaskRegistryReadyAsync({
      ...context,
      admission: { ...context.admission },
    });
    await started.promise;
    release.resolve();
    await readingFlow.promise;
    let thirdReady = false;
    const third = ensureTaskRegistryReadyAsync(context).then(() => {
      thirdReady = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(thirdReady).toBe(false);
      expect(observed).toEqual([]);
    } finally {
      releaseFlow.resolve();
      await Promise.all([first, second, third]);
    }
    expect(loads).toBe(1);
    expect(observed).toEqual([`${task.taskId}:2`]);
    expect(listTasksForOwnerKey(ownerKey).map((entry) => entry.taskId)).toEqual([task.taskId]);
    expect(getTaskDeliveryState(task.taskId)?.lastNotifiedEventAt).toBe(12);
    expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
  });

  it.each(["snapshot", "failure"] as const)(
    "keeps a newer synchronous restore and deletion over a delayed %s",
    async (outcome) => {
      const store = taskStore();
      const snapshot = store.loadSnapshot();
      const failure = new Error("obsolete load failure");
      const started = createDeferred();
      const release = createDeferred();
      configureTaskRegistryRuntime({
        store: {
          ...store,
          withSnapshotAsync: async (_context, consume) => {
            started.resolve();
            await release.promise;
            if (outcome === "failure") {
              throw failure;
            }
            return consume(taskRestoreResult(snapshot), async () => {});
          },
        },
      });
      const pending = ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
      await started.promise;
      try {
        expect(getTaskById(task.taskId)?.notifyPolicy).toBe("silent");
        updateTaskNotifyPolicyById({ taskId: task.taskId, notifyPolicy: "done_only" });
        expect(deleteTaskRecordById(task.taskId)).toBe(true);
      } finally {
        release.resolve();
      }
      await (outcome === "failure" ? expect(pending).rejects.toBe(failure) : pending);
      expect(getTaskById(task.taskId)).toBeUndefined();
    },
  );

  it.each(["synchronous restore", "explicit reload"] as const)(
    "reconciles committed flow state when a newer %s supersedes its snapshot",
    async (replacement) => {
      const currentFlow = { ...flow, syncMode: "task_mirrored" as const };
      const committedFlow = {
        ...currentFlow,
        revision: 1,
        status: "succeeded" as const,
        endedAt: 20,
      };
      const flowStore = createInMemoryTaskFlowRegistryStore({
        flows: new Map([[flow.flowId, currentFlow]]),
      });
      const store = createInMemoryTaskRegistryStore(
        {
          tasks: new Map([
            [task.taskId, { ...task, parentFlowId: flow.flowId, status: "succeeded", endedAt: 20 }],
          ]),
          deliveryStates: new Map(),
        },
        flowStore,
      );
      const context = captureOpenClawStateWorkerContext();
      configureTaskFlowRegistryRuntime({ store: flowStore });
      await ensureTaskFlowRegistryReadyAsync(context);
      const started = createDeferred();
      const release = createDeferred();
      let taskRestores = 0;
      let loads = 0;
      configureTaskRegistryRuntime({
        store: {
          ...store,
          async withSnapshotAsync(_context, consume) {
            const settled = ++loads === 1;
            if (settled) {
              flowStore.upsertFlow(committedFlow);
              started.resolve();
              await release.promise;
            }
            return consume(
              {
                ...taskRestoreResult(store.loadSnapshot()),
                flowSyncs: settled
                  ? [
                      {
                        taskId: task.taskId,
                        flowId: flow.flowId,
                        kind: "result",
                        result: { ok: true, flow: committedFlow },
                      },
                    ]
                  : [],
              },
              () => reconcileTaskFlowRestoreForTests(context, settled ? [flow.flowId] : []),
            );
          },
        },
        observers: {
          onEvent(event) {
            if (event.kind === "restored") {
              taskRestores += 1;
            }
          },
        },
      });
      const pending = ensureTaskRegistryReadyAsync(context);
      await started.promise;
      let reloaded: Promise<void> | undefined;
      try {
        if (replacement === "synchronous restore") {
          expect(getTaskById(task.taskId)?.status).toBe("succeeded");
        } else {
          reloaded = reloadTaskRegistryFromStoreAsync(context);
        }
        expect(getTaskFlowById(flow.flowId)?.status).toBe("running");
      } finally {
        release.resolve();
        await Promise.all([pending, reloaded]);
      }
      expect(getTaskFlowById(flow.flowId)).toMatchObject({ status: "succeeded", revision: 1 });
      expect(taskRestores).toBe(1);
    },
  );

  it("keeps a newer delivery-only commit over a delayed snapshot", async () => {
    const store = taskStore();
    const started = createDeferred();
    const release = createDeferred();
    let loads = 0;
    configureTaskRegistryRuntime({
      store: {
        ...store,
        withSnapshotAsync: async (_context, consume) => {
          const snapshot = store.loadSnapshot();
          loads += 1;
          if (loads === 1) {
            started.resolve();
            await release.promise;
          }
          return consume(taskRestoreResult(snapshot), async () => {});
        },
      },
    });
    const pending = ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
    await started.promise;
    try {
      commitTaskDeliveryFixture({ taskId: task.taskId, lastNotifiedEventAt: 30 });
    } finally {
      release.resolve();
    }
    await pending;
    expect(loads).toBe(1);
    expect(getTaskDeliveryState(task.taskId)?.lastNotifiedEventAt).toBe(30);
  });

  it("keeps an async load failure sticky until the explicit reload boundary", async () => {
    const store = taskStore();
    let fail = true;
    configureTaskRegistryRuntime({
      store: {
        ...store,
        loadSnapshot: () => {
          throw new Error("unexpected synchronous restore");
        },
        withSnapshotAsync: async (_context, consume) => {
          if (fail) {
            throw new Error("synthetic storage failure");
          }
          return consume(taskRestoreResult(store.loadSnapshot()), async () => {});
        },
      },
    });
    const context = captureOpenClawStateWorkerContext();
    await expect(ensureTaskRegistryReadyAsync(context)).rejects.toThrow(
      "Task registry restore failed: synthetic storage failure",
    );
    expect(() => getTaskById(task.taskId)).toThrow("synthetic storage failure");
    fail = false;
    await reloadTaskRegistryFromStoreAsync(context);
    expect(getTaskById(task.taskId)?.task).toBe(task.task);
  });

  it.each(["snapshot", "failure"] as const)(
    "keeps a newer synchronous flow revision over a delayed %s",
    async (outcome) => {
      const store = createInMemoryTaskFlowRegistryStore({ flows: new Map([[flow.flowId, flow]]) });
      const snapshot = store.loadSnapshot();
      const failure = new Error("obsolete flow load");
      const started = createDeferred();
      const release = createDeferred();
      configureTaskFlowRegistryRuntime({
        store: {
          ...store,
          withSnapshotAsync: async (_context, consume) => {
            started.resolve();
            await release.promise;
            if (outcome === "failure") {
              throw failure;
            }
            return consume(snapshot);
          },
        },
      });
      const pending = ensureTaskFlowRegistryReadyAsync(captureOpenClawStateWorkerContext());
      await started.promise;
      expect(
        setFlowWaiting({ flowId: flow.flowId, expectedRevision: 0, currentStep: "updated" }),
      ).toMatchObject({ applied: true });
      release.resolve();
      await (outcome === "failure" ? expect(pending).rejects.toBe(failure) : pending);
      expect(getTaskFlowById(flow.flowId)).toMatchObject({ revision: 1, currentStep: "updated" });
    },
  );

  it("installs a ready flow owner before the caller resumes its synchronous update", async () => {
    const store = createInMemoryTaskFlowRegistryStore({ flows: new Map([[flow.flowId, flow]]) });
    configureTaskFlowRegistryRuntime({
      store: {
        ...store,
        loadSnapshot: () => {
          throw new Error("unexpected synchronous restore");
        },
      },
    });
    await ensureTaskFlowRegistryReadyAsync(captureOpenClawStateWorkerContext());
    expect(readResidentTaskFlow(flow.flowId)).toMatchObject({ revision: 0, goal: flow.goal });
    expect(
      setFlowWaiting({ flowId: flow.flowId, expectedRevision: 0, currentStep: "resumed" }),
    ).toMatchObject({ applied: true });
    expect(readResidentTaskFlow(flow.flowId)).toMatchObject({
      revision: 1,
      currentStep: "resumed",
    });
  });
  describe.each(["task", "flow"] as const)("%s database identity", (kind) => {
    it.each(["async", "sync"] as const)(
      "refreshes ready state after same-identity admission retirement through %s reads",
      async (readMode) => {
        const fixture = identityRestoreFixture(kind, { sameIdentity: true });
        await fixture.ensure(fixture.first);
        tasksWithPendingDelivery.set(task.taskId, Symbol("test delivery claim"));
        vi.spyOn(fixture.first.admission, "assertCurrent").mockImplementation(() => {
          throw new Error("retired fixture admission");
        });
        fixture.select(fixture.second);

        if (readMode === "async") {
          await fixture.ensure(fixture.second);
          expect(fixture.readResident()).toBe("second");
          if (kind === "task") {
            expect(fixture.observed).toEqual(["first", "second"]);
          }
        }
        expect(fixture.read()).toBe("second");
        expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
      },
    );

    it("keeps same-identity restore failures sticky after admission retirement until explicit reload", async () => {
      const fixture = identityRestoreFixture(kind, { sameIdentity: true });
      fixture.beforeSnapshot(async () => {
        throw new Error("fixture restore unavailable");
      });
      await expect(fixture.ensure(fixture.first)).rejects.toThrow("fixture restore unavailable");
      vi.spyOn(fixture.first.admission, "assertCurrent").mockImplementation(() => {
        throw new Error("retired fixture admission");
      });
      fixture.select(fixture.second);
      fixture.beforeSnapshot(async () => {});

      await expect(fixture.ensure(fixture.second)).rejects.toThrow("fixture restore unavailable");
      expect(() => fixture.read()).toThrow("fixture restore unavailable");
      expect(fixture.loads).toEqual(["first"]);
      await fixture.reload(fixture.second);
      expect(fixture.readResident()).toBe("second");
      expect(fixture.read()).toBe("second");
    });

    it("lets the current context restore without waiting for an obsolete snapshot", async () => {
      const fixture = identityRestoreFixture(kind);
      const started = createDeferred();
      const release = createDeferred();
      fixture.beforeSnapshot(async (context) => {
        if (context === fixture.first) {
          started.resolve();
          await release.promise;
        }
      });
      const first = fixture.ensure(fixture.first);
      await started.promise;
      fixture.select(fixture.second);
      const second = fixture.reload(fixture.second);
      try {
        await vi.waitFor(() => {
          expect(fixture.readResident()).toBe("second");
          if (kind === "task") {
            expect(fixture.observed).toEqual(["second"]);
          }
        });
        expect(fixture.read()).toBe("second");
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
      expect(fixture.loads).toEqual(["first", "second"]);
      if (kind === "task") {
        expect(fixture.observed).toEqual(["second"]);
      }
      expect(fixture.readResident()).toBe("second");
      expect(fixture.read()).toBe("second");
    });

    it("qualifies ready state and ignores obsolete reloads while keeping sync readers current", async () => {
      const fixture = identityRestoreFixture(kind);
      await fixture.ensure(fixture.first);
      fixture.select(fixture.second);
      await fixture.ensure(fixture.second);
      expect(fixture.loads).toEqual(["first", "second"]);
      expect(fixture.readResident()).toBe("second");
      expect(fixture.read()).toBe("second");
      await fixture.reload(fixture.first);
      if (kind === "task") {
        expect(fixture.observed).toEqual(["first", "second"]);
      }
      expect(fixture.readResident()).toBe("second");
      expect(fixture.read()).toBe("second");
      fixture.select(fixture.first);
      expect(fixture.read()).toBe("first");
    });
  });
  it("preserves live delivery work when a sync reader reenters a foreign pending restore", async () => {
    const fixture = identityRestoreFixture("task");
    await fixture.ensure(fixture.first);
    tasksWithPendingDelivery.set(task.taskId, Symbol("test delivery claim"));
    const release = createDeferred();
    fixture.beforeSnapshot(async () => {
      await release.promise;
    });
    fixture.select(fixture.second);
    const pending = fixture.ensure(fixture.second);
    try {
      await vi.waitFor(() => expect(fixture.loads).toEqual(["first", "second"]));
      expect(fixture.read()).toBe("second");
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
    expect(fixture.observed).toEqual(["first", "second"]);
    expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
  });
});
