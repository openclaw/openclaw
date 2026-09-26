import { err } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { MessageSendResult } from "../infra/outbound/message.js";
import { drainSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import * as deliveryRuntime from "./task-registry-delivery-runtime.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import {
  commitTaskDeliveryFixture,
  failTaskNotificationPreparationAfterConsume,
} from "./task-registry-delivery.test-support.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import {
  invalidateTaskRegistryProjection,
  reloadTaskRegistryFromStoreAsync,
  resetTaskRegistryRestoreState,
  tasksWithPendingDelivery,
} from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import {
  loadTaskRegistryStateFromSqliteReadOnly,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import {
  createTaskFixture,
  finishTaskFixture,
  resetTaskRegistryForTests,
} from "./task-registry.test-support.js";
import type {
  TaskDeliveryState,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
} from "./task-registry.types.js";
import { bindTaskRunOwner, getTaskRunOwner } from "./task-run-owner.js";

const ownerKey = "agent:main:terminal-notification";
const origin = { channel: "telegram", to: "synthetic-terminal-recipient" };
const sent: MessageSendResult = {
  ...origin,
  via: "direct",
  mediaUrl: null,
  deliveryStatus: "sent",
  result: { messageId: "synthetic-terminal-notification" },
};
const sendMessage = vi.fn<typeof deliveryRuntime.sendMessage>();
let state: OpenClawTestState;
let pending: Array<{ complete: () => void; result: Promise<TaskRecord | null> }>;

function seedTerminal(
  options: {
    runtime?: TaskRuntime;
    scopeKind?: TaskScopeKind;
    ownerKey?: string;
    runId?: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
    childSessionKey?: string;
    terminalOutcome?: TaskRecord["terminalOutcome"];
    status?: "succeeded" | "cancelled";
  } = {},
): TaskRecord {
  const { runtime = "cli", terminalOutcome, status = "succeeded", ...overrides } = options;
  const startedAt = Date.now() - 2_000;
  const running = createTaskFixture(runtime, {
    ownerKey,
    requesterSessionKey: options.scopeKind === "system" ? undefined : ownerKey,
    requesterAgentId: "main",
    requesterOrigin: origin,
    runId: "terminal-notification-run",
    task: "Synthetic terminal task",
    notifyPolicy: "done_only",
    deliveryStatus: "pending",
    startedAt,
    lastEventAt: startedAt,
    ...overrides,
  });
  // This setter prepares a terminal row without launching its notification during fixture setup.
  const terminal = finishTaskFixture({
    taskId: running.taskId,
    status,
    endedAt: startedAt + 1_000,
    terminalSummary: "Synthetic terminal result",
    terminalOutcome,
  });
  if (!terminal) {
    throw new Error("Expected the synthetic terminal task");
  }
  return terminal;
}

function installRetainedTask(task: TaskRecord): void {
  upsertTaskWithDeliveryStateToSqlite({ task });
  publishTaskRecordAfterAtomicStore(task);
  commitTaskDeliveryFixture({ taskId: task.taskId, requesterOrigin: origin });
}

function stored(taskId: string) {
  return loadTaskRegistryStateFromSqliteReadOnly().tasks.get(taskId);
}

function trackHostTaskWrites() {
  return trackSqliteStatementExecutions(
    openOpenClawStateDatabase().db,
    ["task", "delivery"] as const,
    (sql) => {
      if (!/\b(?:insert|update|delete)\b/i.test(sql)) {
        return null;
      }
      if (/\btask_delivery_state\b/i.test(sql)) {
        return "delivery";
      }
      return /\btask_runs\b/i.test(sql) ? "task" : null;
    },
  );
}

function startDirectNotification(task: TaskRecord) {
  const dispatched = createDeferred<Parameters<typeof deliveryRuntime.sendMessage>[0]>();
  const transport = createDeferred<MessageSendResult>();
  sendMessage.mockImplementationOnce(async (params) => {
    dispatched.resolve(params);
    return await transport.promise;
  });
  const result = maybeDeliverTaskTerminalUpdate(task.taskId);
  pending.push({ complete: () => transport.resolve(sent), result });
  return {
    result,
    transport,
    dispatched: Promise.race([
      dispatched.promise,
      result.then(() => {
        throw new Error("Terminal notification settled before direct transport dispatch");
      }),
    ]),
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "task-terminal-notification-",
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
  pending = [];
  sendMessage.mockReset();
  vi.spyOn(deliveryRuntime, "sendMessage").mockImplementation(sendMessage);
  vi.spyOn(deliveryRuntime, "prepareTaskControlUiSessionUrl").mockResolvedValue(() => undefined);
});

afterEach(async () => {
  for (const notification of pending) {
    notification.complete();
  }
  await Promise.allSettled(pending.map(({ result }) => result));
  vi.restoreAllMocks();
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
  await state.cleanup();
});

describe("terminal task notification persistence", () => {
  it.each(["subagent read", "link config"] as const)(
    "does not send or queue after its claim retires during %s preparation",
    async (phase) => {
      vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
      const task = seedTerminal({
        runtime: "subagent",
        status: "cancelled",
        childSessionKey: "agent:main:subagent:retired-preparation",
        requesterOrigin: phase === "subagent read" ? undefined : origin,
      });
      const selected = createDeferred();
      const release = createDeferred();
      const read = stateReads.executeExistingOpenClawStateRead;
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
        async (...args) => {
          const result = await read(...args);
          if (phase === "subagent read" && args[1].type === "subagents.forChildSession") {
            selected.resolve();
            await release.promise;
          }
          return result;
        },
      );
      vi.mocked(deliveryRuntime.prepareTaskControlUiSessionUrl).mockImplementation(async () => {
        selected.resolve();
        await release.promise;
        return () => "https://dashboard.example/synthetic-cancelled-child";
      });
      const notification = maybeDeliverTaskTerminalUpdate(task.taskId);
      const successor = Symbol("successor cancellation notification");
      try {
        await Promise.race([
          selected.promise,
          notification.then(() => {
            throw new Error("Subagent notification settled before its prepared read");
          }),
        ]);
        expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
        tasksWithPendingDelivery.set(task.taskId, successor);
        release.resolve();
        expect(await notification).toBeNull();
        expect(tasksWithPendingDelivery.get(task.taskId)).toBe(successor);
        expect(drainSystemEvents(ownerKey)).toEqual([]);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(stored(task.taskId)?.deliveryStatus).toBe("pending");
      } finally {
        release.resolve();
        await notification;
        if (tasksWithPendingDelivery.get(task.taskId) === successor) {
          tasksWithPendingDelivery.delete(task.taskId);
        }
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["persisted pending", "live released", "live moved"] as const)(
    "prepares subagent cancellation with %s state without host data SQL",
    async (phase) => {
      vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
      clearSubagentRunsReadCacheForTest();
      const childSessionKey = "agent:main:subagent:notification-preparation";
      const task = seedTerminal({ runtime: "subagent", status: "cancelled", childSessionKey });
      const retained: SubagentRunRecord = {
        runId: task.runId!,
        childSessionKey,
        requesterSessionKey: task.ownerKey,
        requesterDisplayKey: "main",
        task: "Synthetic cancelled child",
        cleanup: "keep",
        createdAt: task.createdAt,
        execution: { status: "running", startedAt: task.createdAt },
        completion: { required: false },
        delivery: { status: "not_required" },
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      };
      saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
      if (phase === "live released") {
        subagentRuns.set(retained.runId, { ...retained, requesterSettleWake: undefined });
      } else if (phase === "live moved") {
        subagentRuns.set(retained.runId, {
          ...retained,
          childSessionKey: "agent:main:subagent:other-child",
        });
      }
      sendMessage.mockResolvedValue(sent);
      vi.mocked(deliveryRuntime.prepareTaskControlUiSessionUrl).mockRestore();
      const deliver = async () => {
        const host = observeHostDataSql();
        try {
          const result = await maybeDeliverTaskTerminalUpdate(task.taskId);
          expect(host.calls.map((call) => call.mock.calls.length)).toEqual(host.calls.map(() => 0));
          return result;
        } finally {
          host.restore();
        }
      };
      try {
        const first = await deliver();
        expect(first?.deliveryStatus).toBe(phase === "persisted pending" ? "pending" : "delivered");
        expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
        if (phase === "persisted pending") {
          expect(sendMessage).not.toHaveBeenCalled();
          const released = { ...retained, requesterSettleWake: undefined };
          saveSubagentRegistryToSqlite(new Map([[released.runId, released]]));
          expect((await deliver())?.deliveryStatus).toBe("delivered");
        }
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(stored(task.taskId)?.deliveryStatus).toBe("delivered");
      } finally {
        subagentRuns.delete(retained.runId);
        clearSubagentRunsReadCacheForTest();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    "current owner",
    "replacement store",
    "replacement database",
    "reopened database",
  ] as const)(
    "keeps a failed reload bound to its %s during restart fallback without storage work",
    async (owner) => {
      const task = seedTerminal();
      const store = getTaskRegistryStore();
      const failure = new Error("Synthetic terminal reload failure");
      const restore = vi.spyOn(store, "withSnapshotAsync").mockRejectedValueOnce(failure);
      beginGatewayRestartSignalAdmission();
      const delivery = maybeDeliverTaskTerminalUpdate(task.taskId);
      const context = captureOpenClawStateWorkerContext();
      try {
        await expect(reloadTaskRegistryFromStoreAsync(context)).rejects.toThrow(
          "Task registry restore failed: Synthetic terminal reload failure",
        );
        if (owner === "replacement store") {
          configureTaskRegistryRuntime({ store: { ...store } });
        } else if (owner === "replacement database") {
          vi.stubEnv("OPENCLAW_STATE_DIR", state.path("replacement-state"));
        } else if (owner === "reopened database") {
          await closeOpenClawStateDatabaseAsync();
          openOpenClawStateDatabase();
          expect(captureOpenClawStateWorkerContext().admission.identity.key).toBe(
            context.admission.identity.key,
          );
          expect(() => context.admission.assertCurrent()).toThrow();
        }
        const host = observeHostDataSql();
        try {
          markGatewayRestartDraining();
          if (owner === "current owner" || owner === "reopened database") {
            await expect(delivery).rejects.toThrow(
              "Task registry restore failed: Synthetic terminal reload failure",
            );
          } else {
            await expect(delivery).resolves.toBeNull();
          }
          expect(restore).toHaveBeenCalledOnce();
          expect(host.calls.map((call) => call.mock.calls.length)).toEqual(host.calls.map(() => 0));
          expect(sendMessage).not.toHaveBeenCalled();
          expect(tasksWithPendingDelivery.size).toBe(0);
        } finally {
          host.restore();
        }
      } finally {
        markGatewayRestartDraining();
        await Promise.allSettled([delivery]);
        configureTaskRegistryRuntime({ store });
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["dirty projection", "cold registry"] as const)(
    "prepares and persists terminal delivery with no host data SQL from a %s",
    async (preparation) => {
      const task = seedTerminal();
      if (preparation === "dirty projection") {
        invalidateTaskRegistryProjection();
      } else {
        resetTaskRegistryRestoreState();
      }
      sendMessage.mockResolvedValue(sent);
      const host = observeHostDataSql();
      try {
        const delivered = await maybeDeliverTaskTerminalUpdate(task.taskId);
        expect(delivered?.deliveryStatus).toBe("delivered");
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(host.calls.map((call) => call.mock.calls.length)).toEqual(host.calls.map(() => 0));
      } finally {
        host.restore();
      }
      expect(stored(task.taskId)?.deliveryStatus).toBe("delivered");
    },
  );

  it.each(["accepted blocked followup", "ambiguous send preparation"] as const)(
    "does not requeue %s when follow-up work fails before status persistence",
    async (failurePoint) => {
      const task = seedTerminal({ terminalOutcome: "blocked" });
      const notification = startDirectNotification(task);
      await notification.dispatched;
      const followupFailure = new Error("Synthetic post-send preparation failure");
      let failed = false;
      if (failurePoint === "accepted blocked followup") {
        const events = await import("../infra/system-events.js");
        const enqueue = events.enqueueSystemEvent;
        vi.spyOn(events, "enqueueSystemEvent").mockImplementation((text, options) => {
          if (!failed && options.contextKey?.endsWith(":blocked-followup")) {
            failed = true;
            throw followupFailure;
          }
          return enqueue(text, options);
        });
      } else {
        const registry = await import("./task-registry-read.js");
        vi.spyOn(registry, "prepareTaskRegistryReadOwner").mockImplementationOnce(() => {
          failed = true;
          throw followupFailure;
        });
      }
      const mutation = vi.spyOn(getTaskRegistryStore(), "runInitialMutationAsync");
      notification.transport.resolve(
        failurePoint === "accepted blocked followup"
          ? sent
          : {
              ...sent,
              deliveryStatus: "suppressed",
              suppressionReason: "adapter_returned_no_identity",
            },
      );
      const result = await notification.result;
      expect(failed).toBe(true);
      expect(drainSystemEvents(ownerKey)).toEqual([]);
      expect(result).toBeNull();
      expect(stored(task.taskId)).toMatchObject({ status: "succeeded", deliveryStatus: "pending" });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(mutation).not.toHaveBeenCalled();
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
    },
  );

  it.each([
    { outcome: "confirmed", deliveryStatus: "delivered", fallback: false },
    { outcome: "unconfirmed", deliveryStatus: "failed", fallback: false },
    { outcome: "rejected", deliveryStatus: "failed", fallback: true },
  ] as const)(
    "records $outcome direct delivery without host task or delivery writes",
    async ({ outcome, deliveryStatus, fallback }) => {
      const task = seedTerminal();
      const notification = startDirectNotification(task);
      expect(await notification.dispatched).toMatchObject({
        ...origin,
        content: expect.stringContaining("Synthetic terminal result"),
      });
      const tracker = trackHostTaskWrites();
      try {
        if (outcome === "rejected") {
          notification.transport.reject(new Error("Synthetic transport rejection"));
        } else {
          notification.transport.resolve(
            outcome === "unconfirmed"
              ? {
                  ...origin,
                  via: "direct",
                  mediaUrl: null,
                  deliveryStatus: "suppressed",
                  suppressionReason: "adapter_returned_no_identity",
                }
              : sent,
          );
        }
        const result = await notification.result;
        expect(stored(task.taskId)).toMatchObject({ status: "succeeded", deliveryStatus });
        expect(result).toEqual(stored(task.taskId));
        expect(getTaskById(task.taskId)).toEqual(result);
        expect(drainSystemEvents(ownerKey)).toEqual(
          fallback ? [expect.stringContaining("Synthetic terminal result")] : [],
        );
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(tracker.counts).toEqual({ task: 0, delivery: 0 });
      } finally {
        tracker.restore();
      }
    },
  );

  it.each([
    {
      name: "missing origin",
      options: { requesterOrigin: undefined },
      deliveryStatus: "session_queued",
      queuedText: "Synthetic terminal result",
    },
    {
      name: "ACP parent review without a concrete thread",
      options: { runtime: "acp", childSessionKey: "agent:main:acp:terminal-child" },
      deliveryStatus: "pending",
      queuedText: "Background task ready for review",
    },
    {
      name: "system task without a requester",
      options: { scopeKind: "system", ownerKey: "system:terminal-notification" },
      deliveryStatus: "not_applicable",
      queuedText: undefined,
    },
  ] as const)(
    "persists $name preparation without host task or delivery writes",
    async ({ options, deliveryStatus, queuedText }) => {
      const task = seedTerminal(options);
      const tracker = trackHostTaskWrites();
      try {
        const result = await maybeDeliverTaskTerminalUpdate(task.taskId);
        expect(stored(task.taskId)).toMatchObject({ status: "succeeded", deliveryStatus });
        expect(result).toEqual(stored(task.taskId));
        expect(getTaskById(task.taskId)).toEqual(result);
        expect(drainSystemEvents(ownerKey)).toEqual(
          queuedText ? [expect.stringContaining(queuedText)] : [],
        );
        expect(sendMessage).not.toHaveBeenCalled();
        expect(tracker.counts).toEqual({ task: 0, delivery: 0 });
      } finally {
        tracker.restore();
      }
    },
  );

  it("suppresses a retained duplicate peer without host task or delivery writes", async () => {
    const preferred = seedTerminal({ runtime: "acp" });
    // Current create/reuse coalesces these registrations; retain a historical peer explicitly.
    const duplicate: TaskRecord = {
      ...preferred,
      taskId: `${preferred.taskId}-duplicate`,
      createdAt: preferred.createdAt + 1,
      startedAt: preferred.createdAt + 1,
      endedAt: preferred.createdAt + 2,
      lastEventAt: preferred.createdAt + 2,
    };
    installRetainedTask(duplicate);
    const tracker = trackHostTaskWrites();
    try {
      const result = await maybeDeliverTaskTerminalUpdate(duplicate.taskId);
      expect(stored(duplicate.taskId)?.deliveryStatus).toBe("not_applicable");
      expect(result).toEqual(stored(duplicate.taskId));
      expect(stored(preferred.taskId)).toEqual(preferred);
      expect(drainSystemEvents(ownerKey)).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(tracker.counts).toEqual({ task: 0, delivery: 0 });
    } finally {
      tracker.restore();
    }
  });

  it("does not apply a sent result to a replacement task identity", async () => {
    const task = seedTerminal();
    const notification = startDirectNotification(task);
    await notification.dispatched;
    installRetainedTask({
      ...task,
      runId: "replacement-terminal-run",
      task: "Replacement task",
      terminalSummary: "Replacement result",
    });
    const replacement = stored(task.taskId);
    notification.transport.resolve(sent);
    await notification.result;
    expect(stored(task.taskId)).toEqual(replacement);
    expect(getTaskById(task.taskId)).toEqual(replacement);
    expect(drainSystemEvents(ownerKey)).toEqual([]);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("holds its terminal claim until status settlement without repeating a consumed event", async () => {
    const task = seedTerminal({ requesterOrigin: undefined });
    const store = getTaskRegistryStore();
    const mutate = store.runInitialMutationAsync.bind(store);
    const entered = createDeferred();
    const release = createDeferred();
    const mutations = vi
      .spyOn(store, "runInitialMutationAsync")
      .mockImplementation(async (context, command, assertCurrent) => {
        if (command.type === "tasks.updateNotificationDelivery") {
          entered.resolve();
          await release.promise;
        }
        return mutate(context, command, assertCurrent);
      });
    const first = maybeDeliverTaskTerminalUpdate(task.taskId);
    pending.push({ complete: () => release.resolve(), result: first });
    let second: Promise<TaskRecord | null> | undefined;
    try {
      expect(
        await Promise.race([entered.promise.then(() => "writing"), first.then(() => "settled")]),
      ).toBe("writing");
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
      expect(stored(task.taskId)?.deliveryStatus).toBe("pending");
      expect(drainSystemEvents(ownerKey)).toEqual([
        expect.stringContaining("Synthetic terminal result"),
      ]);
      second = maybeDeliverTaskTerminalUpdate(task.taskId);
      pending.push({ complete: () => release.resolve(), result: second });
      release.resolve();
      const results = await Promise.all([first, second]);
      expect(results).toEqual([stored(task.taskId), stored(task.taskId)]);
      expect(stored(task.taskId)?.deliveryStatus).toBe("session_queued");
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
      expect(drainSystemEvents(ownerKey)).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(mutations).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it.each(["current", "retired"] as const)(
    "keeps a successor claim and pending row after reload with a %s Gateway continuation",
    async (gateway) => {
      const task = seedTerminal();
      const old = startDirectNotification(task);
      const oldOutcome = Promise.allSettled([old.result]);
      await old.dispatched;
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
      if (gateway === "retired") {
        resetGatewayWorkAdmission();
      }
      expect(stored(task.taskId)?.deliveryStatus).toBe("pending");
      const successor = startDirectNotification(task);
      await successor.dispatched;
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
      old.transport.resolve(sent);
      expect(await oldOutcome).toEqual(
        gateway === "current"
          ? [{ status: "fulfilled", value: null }]
          : [
              {
                status: "rejected",
                reason: expect.objectContaining({
                  message: "Task delivery no longer owns its Gateway continuation",
                }),
              },
            ],
      );
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
      expect(stored(task.taskId)?.deliveryStatus).toBe("pending");
      successor.transport.resolve(sent);
      await successor.result;
      expect(stored(task.taskId)?.deliveryStatus).toBe("delivered");
      expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(drainSystemEvents(ownerKey)).toEqual([]);
    },
  );

  it("rolls back the task status when its delivery-row write fails", async () => {
    const warmup = startDirectNotification(seedTerminal());
    await warmup.dispatched;
    warmup.transport.resolve(sent);
    await warmup.result;
    const task = seedTerminal({ runId: "terminal-rollback-run" });
    const notification = startDirectNotification(task);
    await notification.dispatched;
    const before = loadTaskRegistryStateFromSqliteReadOnly();
    const db = openOpenClawStateDatabase().db;
    // The canonical worker is already open; this fails the second write in its live transaction.
    db.exec(`CREATE TRIGGER reject_terminal_delivery BEFORE INSERT ON task_delivery_state
      BEGIN SELECT RAISE(ABORT, 'synthetic terminal delivery-row failure'); END;`);
    try {
      notification.transport.resolve(sent);
      expect(await notification.result).toBeNull();
      expect(loadTaskRegistryStateFromSqliteReadOnly()).toEqual(before);
      expect(stored(task.taskId)?.deliveryStatus).toBe("pending");
      expect(getTaskById(task.taskId)).toEqual(before.tasks.get(task.taskId));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(drainSystemEvents(ownerKey)).toEqual([]);
    } finally {
      db.exec("DROP TRIGGER reject_terminal_delivery");
    }
  });

  it.each(["initial", "fresh"] as const)(
    "settles its queued status before reporting %s preparation cleanup failure",
    async (phase) => {
      const task = seedTerminal();
      if (phase === "initial") {
        commitTaskDeliveryFixture({ taskId: task.taskId });
      } else {
        const runtime = await import("./task-registry-runtime-loaders.js");
        const load = runtime.deliveryRuntimeLoader.load;
        vi.spyOn(runtime.deliveryRuntimeLoader, "load").mockImplementationOnce(async () => {
          const loaded = await load();
          commitTaskDeliveryFixture({ taskId: task.taskId });
          return loaded;
        });
      }
      const cleanupFailure = new Error("Synthetic terminal preparation cleanup failure");
      const registry = await import("./task-registry-state.js");
      const events = await import("../infra/system-events.js");
      const queued = vi.spyOn(events, "enqueueSystemEvent");
      failTaskNotificationPreparationAfterConsume(
        () => queued.mock.calls.length > 0,
        cleanupFailure,
      );
      const warnings = vi.spyOn(registry.taskRegistryLog, "warn");
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const entered = createDeferred();
      const release = createDeferred();
      const mutations = vi
        .spyOn(store, "runInitialMutationAsync")
        .mockImplementation(async (context, command, assertCurrent) => {
          if (command.type === "tasks.updateNotificationDelivery") {
            entered.resolve();
            await release.promise;
          }
          return mutate(context, command, assertCurrent);
        });
      const notification = maybeDeliverTaskTerminalUpdate(task.taskId);
      pending.push({ complete: () => release.resolve(), result: notification });
      let finished = false;
      const outcome = notification
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          finished = true;
        });
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "writing"),
            outcome.then(() => "settled"),
          ]),
        ).toBe("writing");
        expect(finished).toBe(false);
        expect(tasksWithPendingDelivery.has(task.taskId)).toBe(true);
        release.resolve();
        const result = await outcome;
        const persisted = stored(task.taskId);
        expect(persisted?.deliveryStatus).toBe("session_queued");
        expect(getTaskById(task.taskId)).toEqual(persisted);
        if (phase === "initial") {
          expect(result).toEqual({ ok: false, error: cleanupFailure });
        } else {
          expect(result).toEqual({ ok: true, value: persisted });
          expect(warnings.mock.calls.some(([, meta]) => meta?.error === cleanupFailure)).toBe(true);
        }
        expect(tasksWithPendingDelivery.has(task.taskId)).toBe(false);
        expect(mutations).toHaveBeenCalledOnce();
        expect(queued).toHaveBeenCalledOnce();
        expect(drainSystemEvents(ownerKey)).toEqual([
          expect.stringContaining("Synthetic terminal result"),
        ]);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await outcome;
      }
    },
  );

  it("records received delivery after the same task gains a new live run owner", async () => {
    const task = seedTerminal();
    const releaseOriginal = bindTaskRunOwner(task, async () => err("Original run"));
    let releaseSuccessor: (() => void) | undefined;
    try {
      const notification = startDirectNotification(task);
      await notification.dispatched;
      releaseSuccessor = bindTaskRunOwner(task, async () => err("Successor run"));
      const successor = getTaskRunOwner(task);
      expect(successor).toBeDefined();
      releaseOriginal();
      notification.transport.resolve(sent);
      expect(await notification.result).toEqual(stored(task.taskId));
      expect(stored(task.taskId)?.deliveryStatus).toBe("delivered");
      expect(getTaskRunOwner(task)).toBe(successor);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(drainSystemEvents(ownerKey)).toEqual([]);
    } finally {
      releaseOriginal();
      releaseSuccessor?.();
    }
  });

  it("persists a running system task's missing state-change owner without host writes", async () => {
    const task = createTaskFixture("cli", {
      ownerKey: "system:state-notification",
      scopeKind: "system",
      runId: "missing-state-owner-run",
      task: "Synthetic running system task",
      notifyPolicy: "state_changes",
      deliveryStatus: "pending",
    });
    const tracker = trackHostTaskWrites();
    try {
      const result = await maybeDeliverTaskStateChangeUpdate(task, {
        at: Date.now(),
        kind: "progress",
        summary: "Synthetic system progress",
      });
      expect(stored(task.taskId)).toMatchObject({
        status: "running",
        deliveryStatus: "not_applicable",
      });
      expect(result).toEqual(stored(task.taskId));
      expect(getTaskById(task.taskId)).toEqual(result);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(drainSystemEvents(ownerKey)).toEqual([]);
      expect(tracker.counts).toEqual({ task: 0, delivery: 0 });
    } finally {
      tracker.restore();
    }
  });
});
