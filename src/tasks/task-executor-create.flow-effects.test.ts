import { setImmediate } from "node:timers/promises";
import { err } from "@openclaw/normalization-core/result";
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
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { getTaskFlowById, prepareTaskFlowRegistryRead } from "./task-flow-registry.js";
import { applyFlowPatch } from "./task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { buildManagedFlowCancellationPatch } from "./task-initial-flow.rules.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";
import { getTaskActivitySnapshot, recordTaskActivityEvent } from "./task-registry-activity.js";
import { retainCommittedTaskFlowEffects } from "./task-registry-flow-sync.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { deleteTaskRecordById } from "./task-registry-query.js";
import { markTaskRunningByRunId } from "./task-registry-record-api.js";
import { ensureTaskRegistryReadyAsync, taskFlowSyncOwner } from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { bindTaskRunOwner, getTaskRunOwner } from "./task-run-owner.js";
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

async function fixture(
  syncMode: TaskFlowRecord["syncMode"] = "task_mirrored",
  flowIds: readonly string[] = [flow.flowId],
) {
  const initial = {
    ...flow,
    syncMode,
    ...(syncMode === "managed" ? { controllerId: "proof" } : {}),
  };
  const flows = createInMemoryTaskFlowRegistryStore({
    flows: new Map(flowIds.map((flowId) => [flowId, { ...initial, flowId }])),
  });
  const store = createInMemoryTaskRegistryStore(undefined, flows);
  const originalCreate = store.runInitialMutationAsync.bind(store);
  const commands: Array<keyof TaskInitialWorkerOperations> = [];
  const beforeFinalize =
    vi.fn<
      (input: TaskInitialWorkerOperations["flows.finalizeTaskCancellation"]["input"]) => void
    >();
  store.runInitialMutationAsync = async function (context, command, assertCurrent, onGranted) {
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
      "tasks.acknowledgeStateChange": (input) =>
        originalCreate(
          context,
          { type: "tasks.acknowledgeStateChange", input },
          assertCurrent,
          onGranted,
        ),
      "tasks.createRecord": (input) =>
        originalCreate(context, { type: "tasks.createRecord", input }, assertCurrent, onGranted),
      "tasks.settleUnstarted": (input) =>
        originalCreate(context, { type: "tasks.settleUnstarted", input }, assertCurrent, onGranted),
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
      "tasks.finalizeActive": (input) =>
        originalCreate(context, { type: "tasks.finalizeActive", input }, assertCurrent, onGranted),
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
  const create = (
    runtime: TaskRecord["runtime"] = "cli",
    overrides: Partial<
      Pick<
        Parameters<typeof createRunningTaskRunCoreWithReceiptAsync>[0],
        "task" | "childSessionKey" | "parentFlowId"
      >
    > = {},
  ) =>
    createRunningTaskRunCoreWithReceiptAsync({
      runtime,
      scopeKind: "session",
      ownerKey,
      parentFlowId: flow.flowId,
      runId: "committed-run",
      task: "Synthetic linked task",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ...overrides,
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

it("preserves task identity when terminal timestamps precede its normalized lifecycle start", async () => {
  const f = await fixture();
  const created = await f.create();
  if (!created) {
    throw new Error("Expected task receipt");
  }
  const startedAt = created.task.createdAt - 1_000;
  markTaskRunningByRunId({
    runId: created.task.runId!,
    runtime: created.task.runtime,
    startedAt,
  });
  expect(f.store.loadSnapshot().tasks.get(created.task.taskId)?.createdAt).toBe(startedAt);
  const terminal = {
    status: "succeeded",
    endedAt: startedAt - 1_000,
    terminalSummary: "Completed the selected task",
    childSessionKey: "agent:other:unselected",
    detail: { unexpected: "terminal input" },
  } satisfies DetachedTaskTerminalState;
  await created.finalizeActive(terminal, () => true);
  const completed = f.store.loadSnapshot().tasks.get(created.task.taskId);
  expect(completed).toMatchObject({
    status: "succeeded",
    terminalSummary: terminal.terminalSummary,
    createdAt: terminal.endedAt,
    startedAt,
    endedAt: startedAt,
    ownerKey: created.task.ownerKey,
    runtime: created.task.runtime,
    runId: created.task.runId,
    scopeKind: created.task.scopeKind,
  });
  expect(completed?.childSessionKey).toBe(created.task.childSessionKey);
  expect(completed?.detail).toEqual(created.task.detail);
});

it.each(["metadata", "removal", "replacement", "adoption", "prior adoption"] as const)(
  "preserves active run selection across a sibling observer's %s change",
  async (change) => {
    const f = await fixture();
    const first = await f.create("cli", { childSessionKey: ownerKey, task: "First task" });
    const second = await f.create("cli", { childSessionKey: ownerKey, task: "Second task" });
    const unrelated = await f.create("cli", {
      childSessionKey: "agent:main:other",
      task: "Other task",
    });
    if (!first || !second || !unrelated) {
      throw new Error("Expected task receipts");
    }
    let observed = false;
    let releaseAdoption: (() => void) | undefined;
    if (change === "prior adoption") {
      releaseAdoption = bindTaskRunOwner(second.task, async () => err("Synthetic successor"));
    }
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (
            event.kind !== "upserted" ||
            event.task.taskId !== first.task.taskId ||
            event.task.status !== "succeeded" ||
            observed
          ) {
            return;
          }
          observed = true;
          expect(f.commands.filter((command) => command === "tasks.finalizeActive")).toHaveLength(
            1,
          );
          if (change === "removal") {
            deleteTaskRecordById(second.task.taskId);
          } else if (change === "adoption") {
            releaseAdoption = bindTaskRunOwner(second.task, async () => err("Synthetic successor"));
          } else if (change !== "prior adoption") {
            const replacement = {
              ...second.task,
              progressSummary: "Newer observer progress",
              ...(change === "replacement" ? { createdAt: second.task.createdAt + 1 } : {}),
            };
            f.store.upsertTaskWithDeliveryState({ task: replacement });
            publishTaskRecordAfterAtomicStore(replacement);
          }
        },
      },
    });
    try {
      await first.finalizeActive(
        { status: "succeeded", endedAt: Date.now() },
        (task) => !getTaskRunOwner(task),
      );
      expect(observed).toBe(true);
      const rows = f.store.loadSnapshot().tasks;
      expect(rows.get(first.task.taskId)?.status).toBe("succeeded");
      expect(rows.get(unrelated.task.taskId)?.status).toBe("running");
      if (change === "removal") {
        expect(rows.has(second.task.taskId)).toBe(false);
      } else {
        expect(rows.get(second.task.taskId)?.status).toBe(
          change === "metadata" ? "succeeded" : "running",
        );
        if (change === "metadata") {
          expect(rows.get(second.task.taskId)?.progressSummary).toBe("Newer observer progress");
        }
      }
    } finally {
      releaseAdoption?.();
    }
  },
);

it.each(["adopted", "unknown outcome", "acknowledged"] as const)(
  "continues active fanout only after a known row-local refusal (%s)",
  async (outcome) => {
    const f = await fixture();
    const first = await f.create("cli", { task: "First task" });
    const second = await f.create("cli", { task: "Second task" });
    const third = await f.create("cli", { task: "Third task" });
    if (!first || !second || !third) {
      throw new Error("Expected task receipts");
    }
    const published: string[] = [];
    f.beforeFinalize.mockImplementation((input) => {
      published.push(`flow:${input.taskId}`);
    });
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (event.kind === "upserted" && event.task.status === "succeeded") {
            published.push(`task:${event.task.taskId}`);
          }
        },
      },
    });
    const original = f.store.runInitialMutationAsync.bind(f.store);
    const entered = createDeferred();
    const resume = createDeferred();
    const unknownFailure = new Error("Synthetic unknown worker outcome");
    let releaseAdoption: (() => void) | undefined;
    vi.spyOn(f.store, "runInitialMutationAsync").mockImplementation(
      async (context, command, assertCurrent, onGranted) => {
        if (
          command.type === "tasks.finalizeActive" &&
          command.input.taskId === second.task.taskId
        ) {
          entered.resolve();
          await resume.promise;
          if (outcome === "unknown outcome") {
            throw unknownFailure;
          }
          if (outcome === "acknowledged") {
            const receipt = await original(context, command, assertCurrent, onGranted);
            releaseAdoption = bindTaskRunOwner(second.task, async () => err("Synthetic successor"));
            return receipt;
          }
        }
        return original(context, command, assertCurrent, onGranted);
      },
    );
    const completion = first
      .finalizeActive({ status: "succeeded", endedAt: Date.now() }, () => true)
      .catch((error: unknown) => error);
    await entered.promise;
    expect(f.store.loadSnapshot().tasks.get(first.task.taskId)?.status).toBe("succeeded");
    if (outcome !== "acknowledged") {
      releaseAdoption = bindTaskRunOwner(second.task, async () => err("Synthetic successor"));
    }
    try {
      resume.resolve();
      const result = await completion;
      expect(result).toBe(outcome === "unknown outcome" ? unknownFailure : undefined);
      const expectedIds = [
        first.task.taskId,
        ...(outcome === "acknowledged" ? [second.task.taskId] : []),
        ...(outcome !== "unknown outcome" ? [third.task.taskId] : []),
      ];
      expect(published).toEqual(
        expectedIds.flatMap((taskId) => [`flow:${taskId}`, `task:${taskId}`]),
      );
      const rows = f.store.loadSnapshot().tasks;
      expect(rows.get(second.task.taskId)?.status).toBe(
        outcome === "acknowledged" ? "succeeded" : "running",
      );
      expect(rows.get(third.task.taskId)?.status).toBe(
        outcome !== "unknown outcome" ? "succeeded" : "running",
      );
    } finally {
      resume.resolve();
      await completion;
      releaseAdoption?.();
    }
  },
);

it.each(["authority", "backend"] as const)(
  "refuses active finalization when its %s changes before the admitted write",
  async (change) => {
    const f = await fixture();
    const created = await f.create();
    if (!created) {
      throw new Error("Expected task receipt");
    }
    const original = f.store.runInitialMutationAsync.bind(f.store);
    const entered = createDeferred();
    const resume = createDeferred();
    let current = true;
    vi.spyOn(f.store, "runInitialMutationAsync").mockImplementation(
      async (context, command, assertCurrent, onGranted) => {
        if (command.type === "tasks.finalizeActive") {
          entered.resolve();
          await resume.promise;
        }
        return original(context, command, assertCurrent, onGranted);
      },
    );
    const completion = created.finalizeActive(
      { status: "failed", endedAt: Date.now() },
      () => current,
    );
    const rejected = expect(completion).rejects.toThrow();
    try {
      await entered.promise;
      if (change === "authority") {
        current = false;
      } else {
        configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      }
      resume.resolve();
      await rejected;
      expect(f.store.loadSnapshot().tasks.get(created.task.taskId)?.status).toBe("running");
    } finally {
      resume.resolve();
      await rejected;
    }
  },
);

it("publishes the settled active task only after its flow effects and preserves terminal replay", async () => {
  const f = await fixture();
  const created = await f.create();
  if (!created) {
    throw new Error("Expected task receipt");
  }
  const observed: string[] = [];
  configureTaskRegistryRuntime({
    observers: {
      onEvent(event) {
        if (
          event.kind === "upserted" &&
          event.task.taskId === created.task.taskId &&
          event.task.status === "succeeded"
        ) {
          observed.push(f.flows.loadSnapshot().flows.get(flow.flowId)?.status ?? "missing");
        }
      },
    },
  });
  const terminal = { status: "succeeded" as const, endedAt: Date.now() };
  await created.finalizeActive(terminal, () => true);
  const upsert = vi.spyOn(f.store, "upsertTaskWithDeliveryState");
  await created.finalizeActive(terminal, () => true);
  expect(upsert).not.toHaveBeenCalled();
  expect(observed).toEqual(["succeeded", "succeeded"]);
});

it.each([
  "publication",
  "flow overload",
  "flow refusal",
  "mirrored flow publication",
  "managed flow publication",
] as const)("does not advance active fanout past deferred %s", async (failure) => {
  const secondFlowId = "second-flow";
  const managed = failure === "managed flow publication";
  const f = await fixture(managed ? "managed" : "task_mirrored", [flow.flowId, secondFlowId]);
  const first = await f.create("cli", { task: "First task" });
  const second = await f.create("cli", { task: "Second task", parentFlowId: secondFlowId });
  if (!first || !second) {
    throw new Error("Expected task receipts");
  }
  if (failure === "publication") {
    f.failSnapshot();
  } else if (failure.endsWith("flow publication")) {
    const failFlowRead = () =>
      vi
        .spyOn(f.flows, "readFlowAsync")
        .mockRejectedValueOnce(new Error("Synthetic committed flow read failure"));
    if (managed) {
      const current = f.flows.loadSnapshot().flows.get(flow.flowId)!;
      f.flows.upsertFlow({ ...current, cancelRequestedAt: Date.now() });
      f.beforeFinalize.mockImplementationOnce(failFlowRead);
    } else {
      failFlowRead();
    }
  } else {
    const sync = vi.spyOn(f.store, "syncLiveTaskFlowAsync");
    if (failure === "flow overload") {
      sync.mockRejectedValueOnce(new SqliteWorkerError("Synthetic flow capacity", "overloaded"));
    } else {
      sync.mockResolvedValueOnce({
        kind: "result",
        result: { ok: false, reason: "persist_failed", current: flow },
      });
    }
  }

  await first.finalizeActive({ status: "succeeded", endedAt: Date.now() }, () => true);

  expect(f.store.loadSnapshot().tasks.get(first.task.taskId)?.status).toBe("succeeded");
  if (managed) {
    expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("cancelled");
  }
  expect(f.store.loadSnapshot().tasks.get(second.task.taskId)?.status).toBe("running");
  expect(f.commands.filter((command) => command === "tasks.finalizeActive")).toHaveLength(1);
  await drainRetry();
  if (failure.endsWith("flow publication")) {
    const commands = f.commands.length;
    const read = await prepareTaskFlowRegistryRead();
    expect(read?.getTaskFlowById(flow.flowId)?.status).toBe(managed ? "cancelled" : "succeeded");
    expect(f.commands).toHaveLength(commands);
  }
  expect(f.store.loadSnapshot().tasks.get(first.task.taskId)?.status).toBe("succeeded");
  expect(f.store.loadSnapshot().tasks.get(second.task.taskId)?.status).toBe("running");
  expect(f.commands.filter((command) => command === "tasks.finalizeActive")).toHaveLength(1);
});

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

it.each(["current", "retired task store", "retired flow store"] as const)(
  "retains acknowledged metadata flow repair after preparation overload with %s",
  async (owner) => {
    const f = await fixture();
    const initial = await f.create("acp");
    if (!initial) {
      throw new Error("Expected the original mirrored task");
    }
    f.flows.upsertFlow(flow);
    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({ store: f.flows });
    const preparation = vi
      .spyOn(f.flows, "withSnapshotAsync")
      .mockRejectedValueOnce(
        new SqliteWorkerError("Synthetic flow preparation overload", "overloaded"),
      );
    const sync = vi.spyOn(f.store, "syncLiveTaskFlowAsync");
    const created = await createRunningTaskRunCoreWithReceiptAsync({
      runtime: "acp",
      scopeKind: "session",
      ownerKey,
      runId: "committed-run",
      task: "Synthetic linked task",
      sourceId: "acknowledged-metadata",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(created?.task).toMatchObject({
      taskId: initial.task.taskId,
      parentFlowId: flow.flowId,
      sourceId: "acknowledged-metadata",
    });
    expect(preparation).toHaveBeenCalledOnce();
    expect(sync).not.toHaveBeenCalled();
    const committed = f.store.loadSnapshot();
    const replacementFlows = createInMemoryTaskFlowRegistryStore({
      flows: new Map([[flow.flowId, flow]]),
    });
    if (owner === "retired task store") {
      configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
    } else if (owner === "retired flow store") {
      configureTaskFlowRegistryRuntime({ store: replacementFlows });
    }
    await vi.advanceTimersByTimeAsync(999);
    expect(sync).not.toHaveBeenCalled();
    await drainRetry(1);
    expect(f.store.loadSnapshot()).toEqual(committed);
    expect(f.commands.filter((command) => command === "tasks.createRecord")).toHaveLength(2);
    expect(sync).toHaveBeenCalledTimes(owner === "current" ? 1 : 0);
    expect(f.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(
      owner === "current" ? "running" : "queued",
    );
    expect(replacementFlows.loadSnapshot().flows.get(flow.flowId)).toEqual(flow);
    if (owner === "current") {
      expect(getTaskFlowById(flow.flowId)?.status).toBe("running");
    }
  },
);

it("preserves acknowledged cleanup and repairs its flow after a snapshot failure", async () => {
  const f = await fixture();
  const created = await f.create();
  if (!created) {
    throw new Error("Expected a created task");
  }
  f.failSnapshot();
  const settlement = created.settleUnstarted({ status: "failed", endedAt: Date.now() }, () => true);
  expect(created.settleUnstarted({ status: "cancelled", endedAt: Date.now() }, () => true)).toBe(
    settlement,
  );
  expect(await settlement).toBe(true);
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

it.each(["overload", "not-applied result"] as const)(
  "refuses an initial %s flow retry after only the configured flow store is replaced",
  async (failure) => {
    const f = await fixture();
    const sync = vi.spyOn(f.store, "syncLiveTaskFlowAsync");
    if (failure === "overload") {
      sync.mockRejectedValueOnce(
        new SqliteWorkerError("Synthetic pre-dispatch capacity rejection", "overloaded"),
      );
    } else {
      sync.mockResolvedValueOnce({
        kind: "result",
        result: { ok: false, reason: "persist_failed", current: flow },
      });
    }
    const previousFlowWrite = vi.spyOn(f.flows, "upsertFlow");
    const created = await f.create();
    expect(created?.task.status).toBe("running");
    expect(sync).toHaveBeenCalledOnce();
    expect(previousFlowWrite).not.toHaveBeenCalled();
    const committed = f.store.loadSnapshot();
    const replacement = createInMemoryTaskFlowRegistryStore({
      flows: new Map([[flow.flowId, flow]]),
    });
    const replacementFlowWrite = vi.spyOn(replacement, "upsertFlow");
    configureTaskFlowRegistryRuntime({ store: replacement });

    await drainRetry();

    expect(sync).toHaveBeenCalledOnce();
    expect(previousFlowWrite).not.toHaveBeenCalled();
    expect(replacementFlowWrite).not.toHaveBeenCalled();
    expect(f.flows.loadSnapshot().flows.get(flow.flowId)).toEqual(flow);
    expect(replacement.loadSnapshot().flows.get(flow.flowId)).toEqual(flow);
    expect(f.store.loadSnapshot()).toEqual(committed);
    expect(f.commands).toEqual(["tasks.createRecord"]);
  },
);

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

it.each(["settleUnstarted", "finalizeActive"] as const)(
  "does not retry uncertain cancellation outcomes (%s)",
  async (finalize) => {
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
    expect(await created[finalize]({ status: "failed", endedAt: Date.now() }, () => true)).toBe(
      finalize === "settleUnstarted" ? true : undefined,
    );
    await drainRetry(751_000);
    expect(f.beforeFinalize).toHaveBeenCalledTimes(1);
    expect(f.commands.filter((command) => command === `tasks.${finalize}`)).toHaveLength(1);
  },
);

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
