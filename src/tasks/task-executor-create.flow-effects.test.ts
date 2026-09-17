import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { getTaskFlowById } from "./task-flow-registry.js";
import { applyFlowPatch } from "./task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { buildManagedFlowCancellationPatch } from "./task-initial-flow.rules.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";
import { getTaskActivitySnapshot, recordTaskActivityEvent } from "./task-registry-activity.js";
import { retainCommittedTaskFlowEffects } from "./task-registry-flow-sync.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { ensureTaskRegistryReadyAsync, taskFlowSyncOwner } from "./task-registry-state.js";
import { runTaskRecordTransitionOperation } from "./task-registry-transition.operation.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const ownerKey = "agent:main:committed-flow";
const flow: TaskFlowRecord = {
  flowId: "committed-flow",
  syncMode: "task_mirrored",
  ownerKey,
  goal: "Synthetic flow",
  status: "queued",
  notifyPolicy: "silent",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "committed-flow-control-",
  });
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

async function fixture(syncMode: TaskFlowRecord["syncMode"] = "task_mirrored") {
  const initial = {
    ...flow,
    syncMode,
    ...(syncMode === "managed" ? { controllerId: "proof" } : {}),
  };
  const flows = createInMemoryTaskFlowRegistryStore({ flows: new Map([[flow.flowId, initial]]) });
  const store = createInMemoryTaskRegistryStore(undefined, flows);
  const originalCreate = store.runInitialMutationAsync.bind(store);
  const commands: Array<keyof TaskInitialWorkerOperations> = [];
  const beforeFinalize =
    vi.fn<
      (input: TaskInitialWorkerOperations["flows.finalizeTaskCancellation"]["input"]) => void
    >();
  store.runInitialMutationAsync = async function (context, command, assertCurrent) {
    commands.push(command.type);
    context.admission.assertCurrent();
    assertCurrent();
    const unsupported = (): never => {
      throw new Error("Unexpected initial flow command");
    };
    const operations: {
      [Key in keyof TaskInitialWorkerOperations]: (
        input: TaskInitialWorkerOperations[Key]["input"],
      ) =>
        | TaskInitialWorkerOperations[Key]["output"]
        | Promise<TaskInitialWorkerOperations[Key]["output"]>;
    } = {
      "tasks.createRecord": (input) =>
        originalCreate(context, { type: "tasks.createRecord", input }, assertCurrent),
      "tasks.settleUnstarted": (input) =>
        runTaskRecordTransitionOperation(
          {
            kind: "state",
            taskId: input.taskId,
            now: input.now,
            expectedTask: input.expectedTask,
            params: { ...input.terminal, runId: input.expectedTask.runId },
          },
          {
            readCurrent: () => store.loadSnapshot().tasks.get(input.taskId),
            // The fixture uses CLI records; no ACP or subagent backing is involved.
            hasAuthoritativeBacking: (task) => task.runtime === "cli",
            write: (write) => write(),
            assertCurrent,
            upsertTask: (task) => {
              store.upsertTaskWithDeliveryState({ task });
              return true;
            },
            deferCommit: (publish) => publish(),
            onCommitted() {},
          },
        ),
      "flows.finalizeTaskCancellation": (input) => {
        beforeFinalize(input);
        const task = store.loadSnapshot().tasks.get(input.taskId) ?? null;
        if (!task || task.parentFlowId?.trim() !== input.flowId) {
          return { changed: false, task, flow: null };
        }
        const current = flows.loadSnapshot().flows.get(input.flowId) ?? null;
        const patch =
          task &&
          current &&
          buildManagedFlowCancellationPatch(
            task,
            current,
            () =>
              [...store.loadSnapshot().tasks.values()].filter(
                (item) => item.parentFlowId === current.flowId,
              ),
            input.now,
          );
        if (!task || !current || !patch) {
          return { changed: false, task, flow: current };
        }
        assertCurrent();
        const next = applyFlowPatch(current, patch);
        flows.upsertFlow(next);
        return { changed: true, task, flow: next, previous: current };
      },
      "flows.createForTask": unsupported,
      "tasks.linkInitialFlow": unsupported,
      "flows.deleteUnlinkedForTask": unsupported,
    };
    return operations[command.type](command.input);
  };
  configureTaskFlowRegistryRuntime({ store: flows });
  configureTaskRegistryRuntime({ store });
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskRegistryReadyAsync(context);
  getTaskFlowById(flow.flowId);
  const create = () =>
    createRunningTaskRunCoreWithReceiptAsync({
      runtime: "cli",
      scopeKind: "session",
      ownerKey,
      parentFlowId: flow.flowId,
      runId: "committed-run",
      task: "Synthetic linked task",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
  const failSnapshot = () =>
    vi
      .spyOn(store, "loadMutationSnapshotAsync")
      .mockRejectedValueOnce(new Error("Synthetic snapshot read failure"));
  return { flows, store, commands, context, create, failSnapshot, beforeFinalize };
}

async function drainRetry(delayMs = 1_000) {
  await vi.advanceTimersByTimeAsync(delayMs);
  await setImmediate();
  // Observe root settlement without consuming the next fake retry deadline.
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { interval: 0 });
}

it("retains a created task's flow repair when its publication snapshot fails", async () => {
  const f = await fixture();
  f.failSnapshot();
  const created = await f.create();
  expect(created?.task.status).toBe("running");
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("queued");
  await drainRetry();
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
  expect(f.commands.filter((command) => command === "tasks.createRecord")).toHaveLength(1);
});

it("preserves acknowledged cleanup and repairs its flow after a snapshot failure", async () => {
  const f = await fixture();
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  f.failSnapshot();
  expect(
    await created?.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true),
  ).toBe(true);
  expect(f.store.loadSnapshot().tasks.get(created.task.taskId)?.status).toBe("failed");
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
  await drainRetry();
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("failed");
  expect(f.commands.filter((command) => command === "tasks.settleUnstarted")).toHaveLength(1);
});

it("upgrades the pending timer at its original deadline without losing managed cancellation", async () => {
  const f = await fixture("managed");
  // An existing mirror-only obligation must also be upgraded by the cleanup receipt.
  f.failSnapshot();
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  await vi.advanceTimersByTimeAsync(500);
  const sibling: TaskRecord = {
    ...created.task,
    taskId: "newer-sibling",
    runId: "newer-run",
    createdAt: created.task.createdAt + 1,
    startedAt: created.task.createdAt + 1,
    status: "succeeded",
    endedAt: created.task.createdAt + 2,
    lastEventAt: created.task.createdAt + 2,
  };
  f.store.upsertTaskWithDeliveryState({ task: sibling });
  publishTaskRecordAfterAtomicStore(sibling);
  f.flows.upsertFlow({
    ...flow,
    syncMode: "managed",
    controllerId: "proof",
    status: "running",
    cancelRequestedAt: Date.now(),
  });
  f.failSnapshot();
  expect(await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
    true,
  );
  // Exercise the generic timer merge with a later mirror-only acknowledged request.
  retainCommittedTaskFlowEffects(
    f.context,
    f.store,
    created.task,
    "create",
    taskFlowSyncOwner(created.task.taskId),
  );
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
  await vi.advanceTimersByTimeAsync(499);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
  await drainRetry(1);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("cancelled");
  expect(f.commands.filter((command) => command === "flows.finalizeTaskCancellation")).toHaveLength(
    1,
  );
  expect(f.commands.filter((command) => command === "tasks.settleUnstarted")).toHaveLength(1);
});

it("refuses a retained obligation after only the configured flow store is replaced", async () => {
  const f = await fixture();
  f.failSnapshot();
  const created = await f.create();
  expect(created?.task.status).toBe("running");
  const replacement = createInMemoryTaskFlowRegistryStore({
    flows: new Map([[flow.flowId, flow]]),
  });
  configureTaskFlowRegistryRuntime({ store: replacement });
  await drainRetry();
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("queued");
  expect(replacement.loadSnapshot().flows.get(flow.flowId)?.status).toBe("queued");
  expect(f.commands).toEqual(["tasks.createRecord"]);
});

it("does not schedule a task replay or flow repair for an unacknowledged mutation", async () => {
  const f = await fixture();
  const failure = new Error("Unknown task mutation outcome");
  vi.spyOn(f.store, "runInitialMutationAsync").mockRejectedValueOnce(failure);
  await expect(f.create()).rejects.toBe(failure);
  await drainRetry();
  expect(f.store.loadSnapshot().tasks.size).toBe(0);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("queued");
});

it("keeps the captured cancellation target when the task is rebound before store entry", async () => {
  const f = await fixture("managed");
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  const reboundFlow: TaskFlowRecord = {
    ...flow,
    flowId: "rebound-flow",
    syncMode: "managed",
    controllerId: "proof",
    status: "running",
    cancelRequestedAt: Date.now(),
  };
  f.flows.upsertFlow(reboundFlow);
  f.flows.upsertFlow({
    ...flow,
    syncMode: "managed",
    controllerId: "proof",
    status: "running",
    cancelRequestedAt: Date.now(),
  });
  let capturedFlowId: string | undefined;
  f.beforeFinalize.mockImplementation((input) => {
    capturedFlowId = input.flowId;
    const current = f.store.loadSnapshot().tasks.get(created.task.taskId);
    if (!current) {
      throw new Error("Expected the committed terminal task");
    }
    f.store.upsertTaskWithDeliveryState({
      task: { ...current, parentFlowId: reboundFlow.flowId },
    });
  });
  expect(await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
    true,
  );
  expect(capturedFlowId).toBe(flow.flowId);
  expect(f.store.loadSnapshot().tasks.get(created.task.taskId)?.parentFlowId).toBe(
    reboundFlow.flowId,
  );
  expect(f.flows.loadSnapshot().flows.get(reboundFlow.flowId)).toEqual(reboundFlow);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
});

it("preserves successor activity when cleanup commits before a newer row is projected", async () => {
  const f = await fixture();
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  const load = f.store.loadMutationSnapshotAsync.bind(f.store);
  vi.spyOn(f.store, "loadMutationSnapshotAsync").mockImplementationOnce(async (context, scope) => {
    const committed = f.store.loadSnapshot().tasks.get(created.task.taskId);
    if (!committed || committed.status !== "failed") {
      throw new Error("Expected confirmed cleanup before successor publication");
    }
    const successor: TaskRecord = {
      ...committed,
      runId: "successor-run",
      createdAt: committed.createdAt + 1,
      status: "running",
      endedAt: undefined,
    };
    f.store.upsertTaskWithDeliveryState({ task: successor });
    publishTaskRecordAfterAtomicStore(successor);
    recordTaskActivityEvent(successor, {
      runId: "successor-run",
      seq: 1,
      ts: Date.now(),
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "successor-tool" },
    });
    return load(context, scope);
  });
  expect(await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
    true,
  );
  expect(getTaskActivitySnapshot(created.task.taskId)).toMatchObject({
    executionRunId: "successor-run",
    currentTool: { name: "read" },
  });
});

it("retains known-unadmitted cancellation through immediate and delayed overload", async () => {
  const f = await fixture("managed");
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  f.flows.upsertFlow({
    ...flow,
    syncMode: "managed",
    controllerId: "proof",
    status: "running",
    cancelRequestedAt: Date.now(),
  });
  const rejectAdmission = () => {
    throw new SqliteWorkerError("Synthetic pre-dispatch capacity rejection", "overloaded");
  };
  f.beforeFinalize.mockImplementationOnce(rejectAdmission).mockImplementationOnce(rejectAdmission);
  expect(await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
    true,
  );
  expect(f.beforeFinalize).toHaveBeenCalledTimes(1);
  await drainRetry();
  expect(f.beforeFinalize).toHaveBeenCalledTimes(2);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
  await vi.advanceTimersByTimeAsync(4_999);
  expect(f.beforeFinalize).toHaveBeenCalledTimes(2);
  await drainRetry(1);
  expect(f.beforeFinalize).toHaveBeenCalledTimes(3);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("cancelled");
  expect(f.commands.filter((command) => command === "tasks.settleUnstarted")).toHaveLength(1);
});

it("keeps cancellation overload inside the existing finite retry budget", async () => {
  const f = await fixture("managed");
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  f.flows.upsertFlow({
    ...flow,
    syncMode: "managed",
    controllerId: "proof",
    status: "running",
    cancelRequestedAt: Date.now(),
  });
  f.beforeFinalize.mockImplementation(() => {
    throw new SqliteWorkerError("Synthetic pre-dispatch capacity rejection", "overloaded");
  });
  expect(await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
    true,
  );
  for (const delay of [1_000, 5_000, 25_000, 120_000, 600_000]) {
    await drainRetry(delay);
  }
  expect(f.beforeFinalize).toHaveBeenCalledTimes(6);
  await drainRetry(600_000);
  expect(f.beforeFinalize).toHaveBeenCalledTimes(6);
  expect(f.commands.filter((command) => command === "tasks.settleUnstarted")).toHaveLength(1);
  expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("running");
});

it("does not retry uncertain cancellation outcomes", async () => {
  const f = await fixture("managed");
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  f.flows.upsertFlow({
    ...flow,
    syncMode: "managed",
    controllerId: "proof",
    status: "running",
    cancelRequestedAt: Date.now(),
  });
  f.beforeFinalize.mockImplementation(() => {
    throw new SqliteWorkerError("Synthetic uncertain cancellation outcome", "outcome-unknown");
  });
  expect(await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
    true,
  );
  await drainRetry(751_000);
  expect(f.beforeFinalize).toHaveBeenCalledTimes(1);
  expect(f.commands.filter((command) => command === "tasks.settleUnstarted")).toHaveLength(1);
});

it.each(
  (["mirror-only", "callback"] as const).flatMap((pendingKind) =>
    (["current", "continuing overload", "retired task store", "retired flow store"] as const).map(
      (scenario) => ({
        pendingKind,
        scenario,
      }),
    ),
  ),
)(
  "retains cancellation through an overlapping $pendingKind timer with $scenario",
  async ({ pendingKind, scenario }) => {
    const continuing = scenario === "continuing overload";
    const current = scenario === "current" || continuing;
    const f = await fixture("managed");
    const created = await f.create();
    if (!created) {
      throw new Error("Expected a created task");
    }
    f.flows.upsertFlow({
      ...flow,
      syncMode: "managed",
      controllerId: "proof",
      status: "running",
      cancelRequestedAt: Date.now(),
    });
    const rejectAdmission = () => {
      throw new SqliteWorkerError("Synthetic pre-dispatch capacity rejection", "overloaded");
    };
    f.beforeFinalize
      .mockImplementationOnce(rejectAdmission)
      .mockImplementationOnce(rejectAdmission);
    if (continuing) {
      f.beforeFinalize.mockImplementationOnce(rejectAdmission);
    }
    expect(
      await created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true),
    ).toBe(true);
    const release = createDeferred();
    const originalSync = f.store.syncLiveTaskFlowAsync.bind(f.store);
    const live = vi
      .spyOn(f.store, "syncLiveTaskFlowAsync")
      .mockImplementationOnce(async (...args) => {
        await release.promise;
        return originalSync(...args);
      });
    const owner = taskFlowSyncOwner(created.task.taskId);
    const assertCallbackOwner: typeof owner.assertCurrent = (context, store) => {
      owner.assertCurrent(context, store);
      if (getTaskFlowRegistryStore() !== f.flows) {
        throw new Error("Overlapping cancellation flow store is no longer current");
      }
    };
    const pendingCallback = vi.fn(async (context: typeof f.context) => {
      assertCallbackOwner(context, f.store);
      await f.store.runInitialMutationAsync(
        context,
        {
          type: "flows.finalizeTaskCancellation",
          input: { taskId: created.task.taskId, flowId: flow.flowId, now: Date.now() },
        },
        () => assertCallbackOwner(context, f.store),
      );
    });
    const replacement = createInMemoryTaskFlowRegistryStore({
      flows: new Map([[flow.flowId, { ...flow, syncMode: "managed", controllerId: "proof" }]]),
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(live).toHaveBeenCalledOnce();
      expect(f.beforeFinalize).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      retainCommittedTaskFlowEffects(
        f.context,
        f.store,
        created.task,
        "update",
        pendingKind === "callback" ? { ...owner, assertCurrent: assertCallbackOwner } : owner,
        pendingKind === "callback" ? pendingCallback : undefined,
      );
      release.resolve();
      await drainRetry(0);
      expect(f.beforeFinalize).toHaveBeenCalledTimes(2);
      if (scenario === "retired task store") {
        configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      } else if (scenario === "retired flow store") {
        configureTaskFlowRegistryRuntime({ store: replacement });
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(live).toHaveBeenCalledOnce();
      await drainRetry(1);
      expect(live).toHaveBeenCalledTimes(current ? 2 : 1);
      expect(pendingCallback).toHaveBeenCalledTimes(current && pendingKind === "callback" ? 1 : 0);
      expect(f.beforeFinalize).toHaveBeenCalledTimes(current ? 3 : 2);
      expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(
        scenario === "current" ? "cancelled" : "running",
      );
      expect(replacement.loadSnapshot().flows.get(flow.flowId)?.status).toBe("queued");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(live).toHaveBeenCalledTimes(current ? 2 : 1);
      await drainRetry(1);
      expect(live).toHaveBeenCalledTimes(continuing ? 3 : current ? 2 : 1);
      expect(f.beforeFinalize).toHaveBeenCalledTimes(continuing ? 4 : current ? 3 : 2);
      expect(pendingCallback).toHaveBeenCalledTimes(
        current && pendingKind === "callback" ? (continuing ? 2 : 1) : 0,
      );
      expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(
        current ? "cancelled" : "running",
      );
      expect(f.commands.filter((command) => command === "tasks.settleUnstarted")).toHaveLength(1);
      expect(f.commands.filter((command) => command === "tasks.createRecord")).toHaveLength(1);
    } finally {
      release.resolve();
      await drainRetry(0);
    }
  },
);
