import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import {
  getTaskFlowById,
  runTaskFlowRegistryWorkerMutation,
  syncFlowFromTaskResult,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { getTaskById } from "./task-registry-query.js";
import { markTaskTerminalById, updateTaskNotifyPolicyById } from "./task-registry-record-api.js";
import {
  ensureTaskRegistryReadyAsync,
  readTaskRegistryRevision,
  runTaskRegistryWorkerMutation,
  tasks,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveTaskCleanupAfter } from "./task-retention.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const { getActiveGatewayRootWorkCount } = gatewayWorkAdmission;
const ownerKey = "agent:main:live-flow";
const task: TaskRecord = {
  taskId: "live-a",
  runtime: "cli",
  ownerKey,
  requesterSessionKey: ownerKey,
  scopeKind: "session",
  parentFlowId: "live-flow",
  task: "First live task",
  status: "succeeded",
  terminalOutcome: "blocked",
  terminalSummary: "Old summary",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 10,
  lastEventAt: 20,
  endedAt: 20,
};
task.cleanupAfter = resolveTaskCleanupAfter(task);
const flow: TaskFlowRecord = {
  flowId: "live-flow",
  syncMode: "task_mirrored",
  ownerKey,
  goal: "Stale flow",
  status: "running",
  notifyPolicy: "silent",
  revision: 4,
  createdAt: 10,
  updatedAt: 10,
};
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "live-flow-control-" });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  await state.cleanup();
});

async function fixture(records = [task], initialFlows: TaskFlowRecord[] = [flow]) {
  const flows = createInMemoryTaskFlowRegistryStore({
    flows: new Map(initialFlows.map((record) => [record.flowId, record])),
  });
  const store = createInMemoryTaskRegistryStore(
    { tasks: new Map(records.map((record) => [record.taskId, record])), deliveryStates: new Map() },
    flows,
  );
  configureTaskFlowRegistryRuntime({ store: flows });
  configureTaskRegistryRuntime({ store });
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskRegistryReadyAsync(context);
  expect(getTaskFlowById(flow.flowId)?.revision).toBe(
    initialFlows.find((record) => record.flowId === flow.flowId)?.revision,
  );
  return { flows, store, context };
}

function replay() {
  return markTaskTerminalById({
    taskId: task.taskId,
    status: "succeeded",
    endedAt: 20,
    lastEventAt: 20,
  });
}

async function drainRetry() {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
}

it("retains the existing next retry delay after settled storage contention", async () => {
  const { store, flows } = await fixture();
  vi.spyOn(flows, "upsertFlow").mockImplementationOnce(() => {
    throw new Error("Controlled initial flow refusal");
  });
  expect(replay()?.status).toBe("succeeded");
  const live = vi.spyOn(store, "syncLiveTaskFlowAsync").mockResolvedValueOnce({
    kind: "retry",
    reason: "storage_contention",
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await setImmediate();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(live).toHaveBeenCalledOnce();
  expect(flows.loadSnapshot().flows.get(flow.flowId)?.revision).toBe(4);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(live).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await setImmediate();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(live).toHaveBeenCalledTimes(2);
  expect(flows.loadSnapshot().flows.get(flow.flowId)).toMatchObject({
    revision: 5,
    status: "blocked",
  });
});

it.each(["converging", "exhausted"] as const)(
  "bounds %s projection churn within live retry attempts without losing pending publication",
  async (outcome) => {
    const unrelated: TaskRecord = { ...task, taskId: "live-unrelated" };
    delete unrelated.parentFlowId;
    unrelated.cleanupAfter = resolveTaskCleanupAfter(unrelated);
    const { store, flows, context } = await fixture([task, unrelated]);
    vi.spyOn(flows, "upsertFlow").mockImplementationOnce(() => {
      throw new Error("Controlled initial flow refusal");
    });
    expect(replay()?.status).toBe("succeeded");
    const readRows = store.loadSnapshot.bind(store);
    const published: string[] = [];
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (event.kind === "upserted" && event.task.taskId === task.taskId) {
            published.push(event.task.notifyPolicy);
          }
        },
      },
    });
    const release = createDeferred();
    const committed = new Map<string, TaskRecord>();
    const publication = runTaskRegistryWorkerMutation(
      {
        scope: { taskId: task.taskId, flowId: flow.flowId },
        admission: context.admission,
        publicationRecords: () => committed,
      },
      async () => {
        await release.promise;
        const next: TaskRecord = { ...task, notifyPolicy: "state_changes" };
        store.upsertTaskWithDeliveryState({ task: next });
        committed.set(next.taskId, next);
      },
      async () => readRows(),
    );
    let invalidations = 0;
    const asyncRead = vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async () => {
      const snapshot = readRows();
      if (invalidations < (outcome === "converging" ? 3 : 5)) {
        invalidations += 1;
        updateTaskNotifyPolicyById({
          taskId: unrelated.taskId,
          notifyPolicy: invalidations % 2 === 1 ? "state_changes" : "silent",
        });
      }
      return snapshot;
    });
    const live = vi.spyOn(store, "syncLiveTaskFlowAsync");
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await setImmediate();
      expect({
        reads: asyncRead.mock.calls.length,
        syncs: live.mock.calls.length,
        rootWork: getActiveGatewayRootWorkCount(),
        flowRevision: flows.loadSnapshot().flows.get(flow.flowId)?.revision,
      }).toEqual({ reads: 1, syncs: 0, rootWork: 0, flowRevision: 4 });
      let expectedReads = 1;
      const delays =
        outcome === "converging" ? [5_000, 25_000, 120_000] : [5_000, 25_000, 120_000, 600_000];
      for (const delay of delays) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(asyncRead).toHaveBeenCalledTimes(expectedReads);
        await vi.advanceTimersByTimeAsync(1);
        await setImmediate();
        expectedReads += 1;
        expect(asyncRead).toHaveBeenCalledTimes(expectedReads);
        expect(live).toHaveBeenCalledTimes(outcome === "converging" && expectedReads === 4 ? 1 : 0);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      }
      if (outcome === "exhausted") {
        await vi.advanceTimersByTimeAsync(600_000);
        await setImmediate();
        expect(asyncRead).toHaveBeenCalledTimes(5);
        expect(live).not.toHaveBeenCalled();
      }
      expect(flows.loadSnapshot().flows.get(flow.flowId)?.revision).toBe(
        outcome === "converging" ? 5 : 4,
      );
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      release.resolve();
      await publication;
      configureTaskRegistryRuntime({ observers: null });
    }
    expect(getTaskById(task.taskId)?.notifyPolicy).toBe("state_changes");
    expect(published.filter((policy) => policy === "state_changes")).toEqual(["state_changes"]);
  },
);

it("keeps live retry admitted until its union projection read rejects", async () => {
  const unrelated: TaskRecord = { ...task, taskId: "live-unrelated" };
  delete unrelated.parentFlowId;
  const records = [task, unrelated];
  const { store, flows, context } = await fixture(records);
  vi.spyOn(flows, "upsertFlow").mockImplementationOnce(() => {
    throw new Error("Controlled initial flow refusal");
  });
  expect(replay()?.status).toBe("succeeded");
  const publishedTasks = [...tasks.values()];
  const failure = new Error("Union projection read failed");
  const releaseRead = createDeferred();
  const readSnapshot = store.loadMutationSnapshotAsync.bind(store);
  const asyncRead = vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async () => {
    await releaseRead.promise;
    throw failure;
  });
  const releaseMutations = createDeferred();
  const mutations = records.map((record) => {
    const committed = new Map<string, TaskRecord>();
    return runTaskRegistryWorkerMutation(
      {
        scope: { taskId: record.taskId, flowId: flow.flowId },
        admission: context.admission,
        publicationRecords: () => committed,
      },
      async () => {
        const next = { ...record, task: `Stored ${record.taskId}` };
        store.upsertTaskWithDeliveryState({ task: next });
        committed.set(next.taskId, next);
        await releaseMutations.promise;
      },
      () => readSnapshot(context, { taskId: record.taskId, flowId: flow.flowId }),
    );
  });
  const revision = readTaskRegistryRevision();
  const live = vi.spyOn(store, "syncLiveTaskFlowAsync");
  const admission = vi.spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkContinuation");
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(admission).toHaveBeenCalledOnce();
    expect(asyncRead).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const admitted = admission.mock.results[0];
    if (admitted?.type !== "return") {
      throw new Error("Expected the live retry's actual root-work promise");
    }
    const observed = admitted.value.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect([...tasks.values()]).toEqual(publishedTasks);
    expect(readTaskRegistryRevision()).toBe(revision);
    expect(live).not.toHaveBeenCalled();
    releaseRead.resolve();
    expect(await observed).toBe(failure);
    await drainRetry();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect([...tasks.values()]).toEqual(publishedTasks);
    expect(readTaskRegistryRevision()).toBe(revision);
    expect(live).not.toHaveBeenCalled();
    expect(flows.loadSnapshot().flows.get(flow.flowId)?.revision).toBe(4);
  } finally {
    releaseRead.resolve();
    await Promise.allSettled(
      admission.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
    );
    releaseMutations.resolve();
    await Promise.allSettled(mutations);
    await drainRetry();
  }
});

it.each(["missing", "new row", "managed", "mirrored"] as const)(
  "synchronizes a dirty target against its canonical %s row",
  async (boundary) => {
    const cached: TaskFlowRecord =
      boundary === "mirrored"
        ? { ...flow, syncMode: "managed", controllerId: "tests/cached-flow" }
        : flow;
    const current: TaskFlowRecord = {
      ...flow,
      revision: 9,
      goal: "Fresh canonical flow",
      ...(boundary === "managed"
        ? {
            syncMode: "managed" as const,
            controllerId: "tests/current-flow",
            currentStep: "Manual step",
          }
        : {}),
    };
    const { flows, context } = await fixture([task], boundary === "new row" ? [] : [cached]);
    const release = createDeferred();
    const pending = runTaskFlowRegistryWorkerMutation(
      { flowId: flow.flowId, admission: context.admission },
      async () => {
        if (boundary === "missing") {
          flows.deleteFlow(flow.flowId);
        } else {
          flows.upsertFlow(current);
        }
        await release.promise;
      },
      () => flows.readFlowAsync(context, flow.flowId),
    );
    const write = vi.spyOn(flows, "upsertFlow");
    try {
      const result = syncFlowFromTaskResult(task);
      if (boundary === "missing") {
        expect(result).toEqual({ ok: true, flow: null });
        expect(flows.loadSnapshot().flows.has(flow.flowId)).toBe(false);
        expect(write).not.toHaveBeenCalled();
      } else if (boundary === "managed") {
        expect(result).toMatchObject({ ok: true, flow: current });
        expect(flows.loadSnapshot().flows.get(flow.flowId)).toEqual(current);
        expect(write).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          ok: true,
          flow: { revision: 10, status: "blocked", blockedTaskId: task.taskId, goal: task.task },
        });
        expect(flows.loadSnapshot().flows.get(flow.flowId)).toMatchObject({
          revision: 10,
          status: "blocked",
          blockedTaskId: task.taskId,
          goal: task.task,
        });
      }
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(["missing", "managed", "mirrored", "read failure"] as const)(
  "preserves canonical %s classification when dirty synchronization cannot enter",
  async (boundary) => {
    const { flows, context } = await fixture();
    const current: TaskFlowRecord = {
      ...flow,
      revision: 9,
      goal: "Fresh failure metadata",
      ...(boundary === "managed"
        ? {
            syncMode: "managed" as const,
            controllerId: "tests/current-flow",
            currentStep: "Manual step",
          }
        : {}),
    };
    const release = createDeferred();
    const pending = runTaskFlowRegistryWorkerMutation(
      { flowId: flow.flowId, admission: context.admission },
      async () => {
        if (boundary === "missing") {
          flows.deleteFlow(flow.flowId);
        } else {
          flows.upsertFlow(current);
        }
        await release.promise;
      },
      () => flows.readFlowAsync(context, flow.flowId),
    );
    vi.spyOn(flows, "syncMirroredTask").mockImplementationOnce(() => {
      throw new Error("Controlled synchronous store refusal");
    });
    const readError = new Error("Controlled canonical classifier read failure");
    if (boundary === "read failure") {
      vi.spyOn(flows, "loadSnapshot").mockImplementationOnce(() => {
        throw readError;
      });
    }
    const write = vi.spyOn(flows, "upsertFlow");
    try {
      if (boundary === "read failure") {
        expect(() => syncFlowFromTaskResult(task)).toThrow(readError);
      } else {
        const result = syncFlowFromTaskResult(task);
        if (boundary === "missing") {
          expect(result).toEqual({ ok: true, flow: null });
        } else if (boundary === "managed") {
          expect(result).toMatchObject({ ok: true, flow: current });
        } else {
          expect(result).toMatchObject({ ok: false, reason: "persist_failed", current });
        }
      }
      expect(write).not.toHaveBeenCalled();
      expect(flows.loadSnapshot().flows.get(flow.flowId)).toEqual(
        boundary === "missing" ? undefined : current,
      );
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(["missing", "managed"] as const)(
  "does not admit synchronization for a clean %s target",
  async (boundary) => {
    const managed: TaskFlowRecord = {
      ...flow,
      syncMode: "managed",
      controllerId: "tests/clean-flow",
    };
    const { flows } = await fixture([task], boundary === "missing" ? [] : [managed]);
    const sync = vi.spyOn(flows, "syncMirroredTask");
    const result = syncFlowFromTaskResult(task);
    expect(sync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, flow: boundary === "missing" ? null : managed });
  },
);

it("keeps an unrelated pending flow dirty after synchronizing the target", async () => {
  const unrelated: TaskFlowRecord = {
    ...flow,
    flowId: "unrelated-pending-flow",
    syncMode: "managed",
    controllerId: "tests/unrelated-flow",
    goal: "Original unrelated flow",
  };
  const { flows, context } = await fixture([task], [flow, unrelated]);
  const release = createDeferred();
  const pending = runTaskFlowRegistryWorkerMutation(
    { flowId: unrelated.flowId, admission: context.admission },
    () => release.promise,
    () => flows.readFlowAsync(context, unrelated.flowId),
  );
  try {
    expect(syncFlowFromTaskResult(task)).toMatchObject({
      ok: true,
      flow: { revision: 5, status: "blocked" },
    });
    const next = { ...unrelated, revision: 8, goal: "Changed after target synchronization" };
    flows.upsertFlow(next);
    expect(getTaskFlowById(unrelated.flowId)).toMatchObject(next);
  } finally {
    release.resolve();
    await pending;
  }
});

it("repairs a terminal no-op from the flow revision current at store entry", async () => {
  const { store, flows } = await fixture();
  const taskWrites = vi.spyOn(store, "upsertTaskWithDeliveryState");
  const persist = flows.upsertFlow;
  const sync = flows.syncMirroredTask;
  let entered = false;
  const enterWriter = () => {
    if (!entered) {
      entered = true;
      persist({ ...flow, revision: 5, goal: "Intervening committed flow" });
    }
  };
  // Both store entrypoints encounter the same prior committed row. The old
  // prebuilt upsert would overwrite revision 5 with its stale revision 5.
  flows.upsertFlow = (next) => {
    enterWriter();
    persist(next);
  };
  flows.syncMirroredTask = function (input, publish) {
    enterWriter();
    return sync.call(this, input, publish);
  };
  expect(replay()?.status).toBe("succeeded");
  expect(taskWrites).not.toHaveBeenCalled();
  expect(getTaskFlowById(flow.flowId)).toMatchObject({
    revision: 6,
    status: "blocked",
    blockedSummary: "Old summary",
  });
});

it.each(["current row", "retired store", "retired admission"] as const)(
  "awaits dirty projection preparation and checks %s before live retry",
  async (boundary) => {
    const { store, flows, context } = await fixture();
    vi.spyOn(flows, "upsertFlow").mockImplementationOnce(() => {
      throw new Error("Controlled initial flow refusal");
    });
    expect(replay()?.status).toBe("succeeded");
    const readRows = store.loadSnapshot.bind(store);
    const releasePublication = createDeferred();
    const publication = runTaskRegistryWorkerMutation(
      {
        scope: { taskId: task.taskId, flowId: flow.flowId },
        admission: context.admission,
        publicationRecords: () => new Map(),
      },
      () => releasePublication.promise,
      async () => readRows(),
    );
    const releaseRead = createDeferred();
    const asyncRead = vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async () => {
      await releaseRead.promise;
      return readRows();
    });
    const syncRead = vi.spyOn(store, "loadSnapshot").mockImplementation(() => {
      throw new Error("Unexpected synchronous task refresh");
    });
    const syncLive = vi.spyOn(store, "syncLiveTaskFlowAsync");
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(asyncRead).toHaveBeenCalledOnce();
      expect(syncLive).not.toHaveBeenCalled();
      if (boundary === "current row") {
        store.upsertTaskWithDeliveryState({
          task: { ...task, terminalSummary: "Current summary", endedAt: 30, lastEventAt: 30 },
        });
      } else if (boundary === "retired store") {
        configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      } else {
        const prepared = asyncRead.mock.calls[0]?.[0];
        if (!prepared) {
          throw new Error("Expected captured preparation context");
        }
        vi.spyOn(prepared.admission, "assertCurrent").mockImplementation(() => {
          throw new Error("Controlled admission retirement");
        });
      }
      releaseRead.resolve();
      await drainRetry();
      expect(syncRead).not.toHaveBeenCalled();
      if (boundary === "current row") {
        expect(syncLive).toHaveBeenCalledOnce();
        expect(getTaskFlowById(flow.flowId)).toMatchObject({
          status: "blocked",
          blockedSummary: "Current summary",
          endedAt: 30,
        });
      } else {
        expect(syncLive).not.toHaveBeenCalled();
        expect(flows.loadSnapshot().flows.get(flow.flowId)?.revision).toBe(4);
      }
    } finally {
      releaseRead.resolve();
      releasePublication.resolve();
      await publication;
      await drainRetry();
    }
  },
);

it.each(["live equal-time order", "changed winner", "progress replacement"] as const)(
  "uses the current live selection across dispatch: %s",
  async (boundary) => {
    const other = { ...task, taskId: "live-b", task: "Second live task" };
    const { store, flows } = await fixture([task, other]);
    // Durable Map order stays A,B. Atomic publication changes the live Set to B,A.
    store.upsertTaskWithDeliveryState({ task });
    publishTaskRecordAfterAtomicStore(task);
    vi.spyOn(flows, "upsertFlow").mockImplementationOnce(() => {
      throw new Error("Controlled initial flow refusal");
    });
    expect(replay()?.status).toBe("succeeded");
    const release = createDeferred();
    const original = store.syncLiveTaskFlowAsync.bind(store);
    const syncLive = vi
      .spyOn(store, "syncLiveTaskFlowAsync")
      .mockImplementation(async (...args) => {
        await release.promise;
        return original(...args);
      });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(syncLive).toHaveBeenCalledOnce();
      if (boundary === "changed winner") {
        store.upsertTaskWithDeliveryState({ task: other });
        publishTaskRecordAfterAtomicStore(other);
      } else if (boundary === "progress replacement") {
        const updated = { ...task, terminalSummary: "Progress after dispatch" };
        store.upsertTaskWithDeliveryState({ task: updated });
        publishTaskRecordAfterAtomicStore(updated);
      }
      release.resolve();
      await drainRetry();
      expect([...store.loadSnapshot().tasks.keys()]).toEqual(["live-a", "live-b"]);
      expect(flows.loadSnapshot().flows.get(flow.flowId)).toMatchObject(
        boundary === "changed winner"
          ? { revision: 4, goal: "Stale flow" }
          : {
              status: "blocked",
              blockedTaskId: task.taskId,
              blockedSummary:
                boundary === "progress replacement" ? "Progress after dispatch" : "Old summary",
            },
      );
    } finally {
      release.resolve();
      await drainRetry();
    }
  },
);
