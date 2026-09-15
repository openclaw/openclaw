import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  listActiveImageGenerationTasksForSession,
  findDuplicateGuardImageGenerationTaskForSession,
  IMAGE_GENERATION_TASK_KIND,
} from "../agents/media-generation-task-status.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskRegistryStore,
  createInMemoryTaskFlowRegistryStore,
} from "../test-utils/task-registry-store.js";
import { ensureTaskRuntimeStateReady } from "./runtime-internal.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  reloadTaskFlowRegistryFromStoreAsync,
  getTaskFlowById,
  setFlowWaiting,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskDeliveryState, upsertTaskDeliveryState } from "./task-registry-mutation.js";
import { listFreshTasksForOwnerKey } from "./task-registry-query.js";
import type { TaskRegistryRestoreResult } from "./task-registry-restore.worker.js";
import {
  ensureTaskRegistryReadyAsync,
  reloadTaskRegistryFromStoreAsync,
  tasksWithPendingDelivery,
  runTaskRegistryWorkerMutation,
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
  type TaskRegistryStore,
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
          return consume(taskRestoreResult(stores.task(context).loadSnapshot()));
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
      observers: {
        onEvent: (event) => {
          if (event.kind === "restored") {
            observed.push(getTaskFlowById(flow.flowId)?.goal ?? "missing");
          }
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
  };
}

describe("asynchronous registry restoration", () => {
  it("restores complete task and flow state before observers without parent SQLite through close", async () => {
    upsertTaskFlowRegistryRecordToSqlite({ ...flow, flowId: "flow-a", stateJson: { cursor: 3 } });
    upsertTaskWithDeliveryStateToSqlite({
      task: {
        ...task,
        taskId: "retained",
        parentFlowId: "flow-a",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:synthetic",
        detail: { nested: { retained: true } },
      },
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
    const native = requireNodeSqlite();
    const counters = [
      vi.spyOn(native.DatabaseSync.prototype, "prepare"),
      vi.spyOn(native.DatabaseSync.prototype, "exec"),
      ...(["iterate", "get", "all", "run"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
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
    const mutationDone = createDeferred();
    const scope = { taskId: "retained", flowId: "flow-a", runId: task.runId };
    const store = getTaskRegistryStore();
    const complete = await store.loadMutationSnapshotAsync(context);
    expect([...complete.tasks.keys()]).toEqual(["legacy-mirror", "retained", "stale-mirror"]);
    expect(complete.deliveryStates.get("retained")?.lastNotifiedEventAt).toBe(50);
    const pendingMutation = runTaskRegistryWorkerMutation(
      { admission: context.admission, scope },
      () => mutationDone.promise,
      () => store.loadMutationSnapshotAsync(context, scope),
    );
    try {
      const fresh = await listFreshTasksForOwnerKey(context, ownerKey);
      expect(fresh.map((entry) => entry.taskId)).toEqual([
        "stale-mirror",
        "retained",
        "legacy-mirror",
      ]);
      expect(fresh.find((entry) => entry.taskId === "retained")?.detail).toEqual({
        nested: { retained: true },
      });
      expect(
        (await listActiveImageGenerationTasksForSession(ownerKey)).map((entry) => entry.taskId),
      ).toEqual(["retained"]);
      expect((await findDuplicateGuardImageGenerationTaskForSession(ownerKey))?.taskId).toBe(
        "retained",
      );
    } finally {
      mutationDone.resolve();
      await pendingMutation;
    }
    await closeOpenClawStateDatabaseAsync();
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it.each(["snapshot-first", "mutation-first"] as const)(
    "refreshes a dirty projection with %s settlement without losing newer state or publication",
    async (order) => {
      const store = createInMemoryTaskRegistryStore({
        tasks: new Map([
          ["z-first", { ...task, taskId: "z-first" }],
          ["a-second", { ...task, taskId: "a-second" }],
        ]),
        deliveryStates: new Map([["z-first", { taskId: "z-first", lastNotifiedEventAt: 12 }]]),
      });
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      let readCount = 0;
      const observed: string[] = [];
      const configured = {
        ...store,
        async loadMutationSnapshotAsync() {
          const snapshot = store.loadSnapshot();
          snapshot.tasks = new Map([...snapshot.tasks].toReversed());
          readCount += 1;
          if (readCount === 1) {
            readStarted.resolve();
            await releaseRead.promise;
          }
          return snapshot;
        },
      };
      configureTaskRegistryRuntime({
        store: configured,
        observers: {
          onEvent: (event) => {
            if (event.kind === "upserted") {
              observed.push(event.task.notifyPolicy);
            }
          },
        },
      });
      const context = captureOpenClawStateWorkerContext();
      await ensureTaskRegistryReadyAsync(context);
      const finishMutation = createDeferred();
      const mutation = runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope: { taskId: "z-first", flowId: "flow-a", runId: task.runId },
        },
        async () => {
          await finishMutation.promise;
          store.upsertTaskWithDeliveryState({
            task: { ...task, taskId: "z-first", notifyPolicy: "state_changes" },
            deliveryState: { taskId: "z-first", lastNotifiedEventAt: 12 },
          });
        },
        async () => store.loadSnapshot(),
      );
      const fresh = listFreshTasksForOwnerKey(context, ownerKey);
      await readStarted.promise;
      try {
        if (order === "snapshot-first") {
          releaseRead.resolve();
          expect((await fresh).find((entry) => entry.taskId === "z-first")?.notifyPolicy).toBe(
            "silent",
          );
          finishMutation.resolve();
          await mutation;
        } else {
          finishMutation.resolve();
          await mutation;
          releaseRead.resolve();
          expect((await fresh).find((entry) => entry.taskId === "z-first")?.notifyPolicy).toBe(
            "state_changes",
          );
        }
      } finally {
        releaseRead.resolve();
        finishMutation.resolve();
        await Promise.all([fresh, mutation]);
      }
      expect(listTasksForOwnerKey(ownerKey).map((entry) => entry.taskId)).toEqual([
        "a-second",
        "z-first",
      ]);
      expect(getTaskById("z-first")?.notifyPolicy).toBe("state_changes");
      expect(getTaskDeliveryState("z-first")?.lastNotifiedEventAt).toBe(12);
      expect(observed).toEqual(["state_changes"]);
    },
  );

  it.each([
    ["root", "success"],
    ["store", "success"],
    ["admission", "success"],
    ["root", "failure"],
  ] as const)(
    "rejects a fresh lookup after %s replacement and %s settlement",
    async (replacement, outcome) => {
      const fixture = identityRestoreFixture("task");
      const started = createDeferred();
      const lookup = createDeferred<TaskRecord[]>();
      configureTaskRegistryRuntime({
        store: {
          ...getTaskRegistryStore(),
          listTasksForOwnerKey: () => {
            started.resolve();
            return lookup.promise;
          },
        },
      });
      const fresh = listFreshTasksForOwnerKey(fixture.first, ownerKey);
      const rejected = expect(fresh).rejects.toThrow(
        replacement === "admission" ? "retired" : "no longer current",
      );
      await started.promise;
      if (replacement === "root") {
        fixture.select(fixture.second);
      } else if (replacement === "store") {
        configureTaskRegistryRuntime({ store: taskStore() });
      } else {
        vi.spyOn(fixture.first.admission, "assertCurrent").mockImplementation(() => {
          throw new Error("retired");
        });
      }
      if (outcome === "success") {
        lookup.resolve([task]);
      } else {
        lookup.reject(new Error("owner lookup unavailable"));
      }
      await rejected;
    },
  );

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
          return consume({
            ...taskRestoreResult(store.loadSnapshot()),
            flowSyncs: [
              {
                taskId: task.taskId,
                flowId: flow.flowId,
                kind: "result",
                result: { ok: true, flow: { ...flow, revision: 1 } },
              },
            ],
          });
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
    tasksWithPendingDelivery.add(task.taskId);
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
      const started = createDeferred();
      const release = createDeferred();
      configureTaskRegistryRuntime({
        store: {
          ...store,
          withSnapshotAsync: async (_context, consume) => {
            started.resolve();
            await release.promise;
            if (outcome === "failure") {
              throw new Error("obsolete load failure");
            }
            return consume(taskRestoreResult(snapshot));
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
      await pending;
      expect(getTaskById(task.taskId)).toBeUndefined();
    },
  );

  it.each([
    "superseded store",
    "earlier receipt error",
    "closed maintenance scope",
    "flow read error",
    "retry flow read error",
  ] as const)("retains durable flow repair obligations across %s", async (boundary) => {
    const maintenance =
      boundary === "closed maintenance scope"
        ? createOpenClawDatabaseMaintenanceScope(() => {
            throw new Error("Unexpected schema delegation in memory fixture");
          })
        : undefined;
    if (!maintenance) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const started = createDeferred();
    const release = createDeferred();
    const retried = createDeferred<{
      context: OpenClawStateWorkerContext;
      error: unknown;
    }>();
    const current = { ...flow, syncMode: "task_mirrored" as const };
    const createStore = () => {
      const flows = createInMemoryTaskFlowRegistryStore({
        flows: new Map([[flow.flowId, current]]),
      });
      const store = createInMemoryTaskRegistryStore(
        {
          tasks: new Map([
            [
              task.taskId,
              {
                ...task,
                parentFlowId: flow.flowId,
                status: "succeeded",
                endedAt: 20,
              },
            ],
          ]),
          deliveryStates: new Map(),
        },
        flows,
      );
      const result: TaskRegistryRestoreResult = {
        ...taskRestoreResult(store.loadSnapshot()),
        flowSyncs: [
          {
            taskId: task.taskId,
            flowId: flow.flowId,
            kind: "result",
            result: { ok: false, reason: "persist_failed", current },
          },
        ],
      };
      return { store, flows, result };
    };
    const first = createStore();
    const second = createStore();
    const erroredReceipt = boundary === "flow read error" || boundary === "retry flow read error";
    let retryErrorPending = boundary === "retry flow read error";
    if (erroredReceipt) {
      first.result.settledTasks = [...first.result.snapshot.tasks.values()];
      first.result.flowSyncs = [
        {
          taskId: task.taskId,
          flowId: flow.flowId,
          kind: "error",
          error: serializeAgentSchemaInspectionError(new Error("flow read unavailable")),
        },
      ];
    }
    if (boundary === "earlier receipt error") {
      first.result.flowSyncs.unshift({
        taskId: "earlier-task",
        kind: "error",
        error: serializeAgentSchemaInspectionError(new Error("earlier receipt unavailable")),
      });
    }
    configureTaskFlowRegistryRuntime({
      store: maintenance || erroredReceipt ? first.flows : second.flows,
    });
    configureTaskRegistryRuntime({
      store: {
        ...first.store,
        async syncTaskFlowAsync(this: TaskRegistryStore, context, params) {
          let failure: unknown;
          try {
            context.maintenanceScope?.assertAdmission();
            if (retryErrorPending) {
              retryErrorPending = false;
              return {
                taskId: params.taskId,
                flowId: flow.flowId,
                kind: "error",
                error: serializeAgentSchemaInspectionError(
                  new Error("retry flow read unavailable"),
                ),
              };
            }
            return await first.store.syncTaskFlowAsync.call(this, context, params);
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            retried.resolve({ context, error: failure });
          }
        },
        async withSnapshotAsync(_context, consume) {
          started.resolve();
          await release.promise;
          return consume(first.result);
        },
      },
    });
    const restore = () => ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
    const pending = maintenance ? maintenance.run(restore) : restore();
    await started.promise;
    if (boundary === "superseded store") {
      configureTaskRegistryRuntime({
        store: {
          ...second.store,
          withSnapshotAsync: async (_context, consume) => consume(second.result),
        },
      });
    }
    release.resolve();
    try {
      if (erroredReceipt) {
        await expect(pending).rejects.toThrow("flow read unavailable");
        await expect(restore()).rejects.toThrow("flow read unavailable");
        first.result.settledTasks = [];
        first.result.flowSyncs = [];
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(current.status);
      } else if (boundary === "earlier receipt error") {
        await expect(pending).rejects.toThrow("earlier receipt unavailable");
      } else {
        await pending;
      }
      if (maintenance) {
        await maintenance.close();
        expect(() => maintenance.assertAdmission()).toThrow("maintenance resource scope is closed");
        const retry = await retried.promise;
        expect(retry.error).toBeUndefined();
        expect(retry.context.maintenanceScope).toBeUndefined();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
        if (boundary === "retry flow read error") {
          expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(current.status);
          await vi.advanceTimersByTimeAsync(5_000);
        }
      }
      await vi.waitFor(() => {
        expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("succeeded");
        if (boundary === "superseded store") {
          expect(second.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("succeeded");
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      await maintenance?.close();
      vi.useRealTimers();
    }
  });

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
            return consume({
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
            });
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
          return consume(taskRestoreResult(snapshot));
        },
      },
    });
    const pending = ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
    await started.promise;
    try {
      upsertTaskDeliveryState({ taskId: task.taskId, lastNotifiedEventAt: 30 });
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
          return consume(taskRestoreResult(store.loadSnapshot()));
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
      const started = createDeferred();
      const release = createDeferred();
      configureTaskFlowRegistryRuntime({
        store: {
          ...store,
          withSnapshotAsync: async (_context, consume) => {
            started.resolve();
            await release.promise;
            if (outcome === "failure") {
              throw new Error("obsolete flow load");
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
      await pending;
      expect(getTaskFlowById(flow.flowId)).toMatchObject({ revision: 1, currentStep: "updated" });
    },
  );

  describe.each(["task", "flow"] as const)("%s database identity", (kind) => {
    it.each(["async", "sync"] as const)(
      "refreshes ready state after same-identity admission retirement through %s reads",
      async (readMode) => {
        const fixture = identityRestoreFixture(kind, { sameIdentity: true });
        await fixture.ensure(fixture.first);
        tasksWithPendingDelivery.add(task.taskId);
        vi.spyOn(fixture.first.admission, "assertCurrent").mockImplementation(() => {
          throw new Error("retired fixture admission");
        });
        fixture.select(fixture.second);

        if (readMode === "async") {
          await fixture.ensure(fixture.second);
          expect(fixture.observed).toEqual(["first", "second"]);
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
        await vi.waitFor(() => expect(fixture.observed).toEqual(["second"]));
        expect(fixture.read()).toBe("second");
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
      expect(fixture.loads).toEqual(["first", "second"]);
      expect(fixture.observed).toEqual(["second"]);
      expect(fixture.read()).toBe("second");
    });

    it("qualifies ready state and ignores obsolete reloads while keeping sync readers current", async () => {
      const fixture = identityRestoreFixture(kind);
      await fixture.ensure(fixture.first);
      fixture.select(fixture.second);
      await fixture.ensure(fixture.second);
      expect(fixture.loads).toEqual(["first", "second"]);
      expect(fixture.read()).toBe("second");
      await fixture.reload(fixture.first);
      expect(fixture.observed).toEqual(["first", "second"]);
      expect(fixture.read()).toBe("second");
      fixture.select(fixture.first);
      expect(fixture.read()).toBe("first");
    });
  });
  it("preserves live delivery work when a sync reader reenters a foreign pending restore", async () => {
    const fixture = identityRestoreFixture("task");
    await fixture.ensure(fixture.first);
    tasksWithPendingDelivery.add(task.taskId);
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
