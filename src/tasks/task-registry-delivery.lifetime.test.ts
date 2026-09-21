import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MessageSendResult } from "../infra/outbound/message.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import type { TaskDeliveryState, TaskEventRecord, TaskRecord } from "./task-registry.types.js";

const storage = vi.hoisted(() => ({
  tasks: new Map<string, TaskRecord>(),
  delivery: new Map<string, TaskDeliveryState>(),
  pending: new Set<string>(),
  ensureReady: vi.fn(),
  update: vi.fn<(taskId: string, patch: Partial<TaskRecord>) => TaskRecord | null>(),
  upsertDelivery: vi.fn<(state: TaskDeliveryState) => TaskDeliveryState>(),
  send: vi.fn<typeof import("./task-registry-delivery-runtime.js").sendMessage>(),
  enqueue: vi.fn(),
  heartbeat: vi.fn(),
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: function forbiddenDatabaseOpen() {
    throw new Error("Task delivery lifetime proof must not open SQLite");
  },
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock("./task-registry-state.js", () => ({
  tasks: storage.tasks,
  taskDeliveryStates: storage.delivery,
  tasksWithPendingDelivery: storage.pending,
  ensureTaskRegistryReady: storage.ensureReady,
  withTaskRegistryMutation: <T>(operation: () => T) => operation(),
  getTasksByRunId: (runId: string) =>
    [...storage.tasks.values()].filter((task) => task.runId === runId),
  taskRegistryLog: { warn: vi.fn() },
}));
vi.mock("./task-registry-mutation.js", () => ({
  updateTask: storage.update,
  upsertTaskDeliveryState: storage.upsertDelivery,
  getTaskDeliveryState: (taskId: string) => storage.delivery.get(taskId),
}));
vi.mock("./task-flow-runtime-internal.js", () => ({ getTaskFlowById: () => undefined }));
vi.mock("./task-registry-runtime-loaders.js", () => ({
  loadTaskRegistryDeliveryRuntime: async () => ({ sendMessage: storage.send }),
}));
vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent: storage.enqueue }));
vi.mock("../infra/heartbeat-wake.js", () => ({ requestHeartbeat: storage.heartbeat }));

const origin = { channel: "telegram", to: "123" };
const sent: MessageSendResult = { ...origin, via: "direct", mediaUrl: null };
const event: TaskEventRecord = { at: 20, kind: "running", summary: "Started" };

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.resetAllMocks();
  storage.tasks.clear();
  storage.delivery.clear();
  storage.pending.clear();
  storage.update.mockImplementation((taskId, patch) => {
    const current = storage.tasks.get(taskId);
    if (!current) {
      return null;
    }
    const next = { ...current, ...patch };
    storage.tasks.set(taskId, next);
    return structuredClone(next);
  });
  storage.upsertDelivery.mockImplementation((state) => {
    storage.delivery.set(state.taskId, structuredClone(state));
    return state;
  });
  storage.send.mockResolvedValue(sent);
});

afterEach(() => {
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  resetGatewayWorkAdmission();
});

function seed(kind: "quiet" | "terminal" | "state"): TaskRecord {
  const task: TaskRecord = {
    taskId: "delivery-task",
    runtime: "cli",
    ownerKey: "agent:main:delivery-lifetime",
    requesterSessionKey: "agent:main:delivery-lifetime",
    requesterAgentId: "main",
    scopeKind: "session",
    runId: "delivery-run",
    task: "Synthetic notification",
    status: kind === "state" ? "running" : "succeeded",
    notifyPolicy: kind === "quiet" ? "silent" : kind === "state" ? "state_changes" : "done_only",
    deliveryStatus: kind === "quiet" ? "not_applicable" : "pending",
    createdAt: 1,
    ...(kind === "state" ? {} : { endedAt: 10 }),
  };
  storage.tasks.set(task.taskId, structuredClone(task));
  storage.delivery.set(task.taskId, { taskId: task.taskId, requesterOrigin: origin });
  return task;
}

async function closeCaller(parent: "absent" | "released") {
  const work = new AsyncWorkScope();
  const root = parent === "released" ? tryBeginGatewayRootWorkAdmission("producer") : undefined;
  const capture = () => work.run(() => AsyncLocalStorage.snapshot());
  const run = root ? await root.run(async () => capture()) : capture();
  root?.release();
  await work.drain();
  return { signal: work.signal, run };
}

it.each(["absent", "released"] as const)(
  "resolves quiet paired notifications after the producer closes with an %s root",
  async (parent) => {
    const task = seed("quiet");
    const caller = await closeCaller(parent);
    const outcomes = await caller.run(() =>
      Promise.allSettled([
        maybeDeliverTaskStateChangeUpdate(task.taskId, event),
        maybeDeliverTaskTerminalUpdate(task.taskId),
      ]),
    );
    await setImmediate();
    expect(outcomes).toEqual([
      { status: "fulfilled", value: task },
      { status: "fulfilled", value: task },
    ]);
    expect(storage.tasks.get(task.taskId)).toEqual(task);
    expect(storage.send).not.toHaveBeenCalled();
    expect(storage.update).not.toHaveBeenCalled();
    expect(storage.upsertDelivery).not.toHaveBeenCalled();
    expect(storage.enqueue).not.toHaveBeenCalled();
    expect(storage.heartbeat).not.toHaveBeenCalled();
  },
);

it.each([
  { kind: "terminal", parent: "absent" },
  { kind: "state", parent: "released" },
] as const)(
  "owns $kind delivery and its cleanup after the $parent producer closes",
  async ({ kind, parent }) => {
    const task = seed(kind);
    const caller = await closeCaller(parent);
    const started = createDeferred();
    const send = createDeferred<MessageSendResult>();
    const cleanup = createDeferred();
    let cleanupWork: Promise<void> | undefined;
    let deliverySignal: AbortSignal | undefined;
    storage.send.mockImplementation(async () => {
      deliverySignal = getAsyncWorkSignal();
      cleanupWork = trackAsyncWork(() => cleanup.promise);
      started.resolve();
      return await send.promise;
    });
    const result = caller.run(() =>
      (kind === "terminal"
        ? maybeDeliverTaskTerminalUpdate(task.taskId)
        : maybeDeliverTaskStateChangeUpdate(task.taskId, event)
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    try {
      expect(
        await Promise.race([started.promise.then(() => "started"), result.then(() => "settled")]),
      ).toBe("started");
      expect(deliverySignal).toBeDefined();
      expect(deliverySignal).not.toBe(caller.signal);
      expect(deliverySignal?.aborted).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(storage.tasks.get(task.taskId)?.deliveryStatus).toBe("pending");
      send.resolve(sent);
      expect(await result).toMatchObject({ ok: true });
      await setImmediate();
      expect(storage.send).toHaveBeenCalledOnce();
      expect(storage.send).toHaveBeenCalledWith(
        expect.objectContaining({ ...origin, agentId: "main" }),
      );
      expect(storage.enqueue).not.toHaveBeenCalled();
      expect(storage.pending.size).toBe(0);
      if (kind === "terminal") {
        expect(storage.tasks.get(task.taskId)?.deliveryStatus).toBe("delivered");
      } else {
        expect(storage.delivery.get(task.taskId)?.lastNotifiedEventAt).toBe(event.at);
        expect(storage.tasks.get(task.taskId)?.deliveryStatus).toBe("pending");
      }
      expect(deliverySignal?.aborted).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      send.resolve(sent);
      cleanup.resolve();
      await cleanupWork;
      await result;
      await setImmediate();
    }
    expect(deliverySignal?.aborted).toBe(true);
  },
);

it.each(["resume", "restart"] as const)(
  "keeps closed-producer delivery behind suspension until %s",
  async (outcome) => {
    const task = seed("terminal");
    const caller = await closeCaller("released");
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    let settled = false;
    const result = caller
      .run(() => maybeDeliverTaskTerminalUpdate(task.taskId))
      .then(
        (value) => {
          settled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
    try {
      await setImmediate();
      expect(settled).toBe(false);
      expect(storage.send).not.toHaveBeenCalled();
      expect(storage.update).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (outcome === "restart") {
        markGatewayRestartDraining();
      } else {
        suspension?.release();
      }
      expect(await result).toMatchObject({ ok: true });
      expect(storage.send).toHaveBeenCalledTimes(outcome === "resume" ? 1 : 0);
      expect(storage.tasks.get(task.taskId)?.deliveryStatus).toBe(
        outcome === "resume" ? "delivered" : "pending",
      );
    } finally {
      suspension?.release();
      await result;
      await setImmediate();
    }
  },
);

it("preserves initial restore failure even when restart would defer delivery", async () => {
  const task = seed("terminal");
  const caller = await closeCaller("absent");
  const failure = new Error("Task registry restore failed");
  storage.ensureReady.mockImplementation(() => {
    throw failure;
  });
  markGatewayRestartDraining();
  await expect(caller.run(() => maybeDeliverTaskTerminalUpdate(task.taskId))).rejects.toBe(failure);
  expect(storage.send).not.toHaveBeenCalled();
  expect(storage.update).not.toHaveBeenCalled();
  expect(storage.tasks.get(task.taskId)).toEqual(task);
});
