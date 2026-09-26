import { err } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { MessageSendResult } from "../infra/outbound/message.js";
import * as stateCoordinator from "../infra/state-database-coordinator.js";
import * as systemEvents from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.test-support.js";
import type { sendMessage as SendMessage } from "./task-registry-delivery-runtime.js";
import { maybeDeliverTaskStateChangeUpdate } from "./task-registry-delivery.js";
import {
  captureTaskDeliveryWork,
  failTaskNotificationPreparationAfterConsume,
  commitTaskDeliveryFixture,
} from "./task-registry-delivery.test-support.js";
import * as taskRegistryListener from "./task-registry-listener-state.js";
import { applyTaskRegistryMaintenanceRetention } from "./task-registry-maintenance-retention.js";
import { getTaskDeliveryState, updateTask } from "./task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import * as deliveryRuntime from "./task-registry-runtime-loaders.js";
import * as taskRegistryState from "./task-registry-state.js";
import { getTaskById, markTaskRunningByRunId } from "./task-registry.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import {
  loadTaskRegistryMutationStateFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import { createTaskFixture, resetTaskRegistryForTests } from "./task-registry.test-support.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";
import { bindTaskRunOwner, getTaskRunOwner } from "./task-run-owner.js";

const sendMessage = vi.hoisted(() => vi.fn<typeof SendMessage>());
vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage,
  prepareTaskControlUiSessionUrl: async () => () => undefined,
}));

const ownerKey = "agent:main:state-notification";
const runId = "state-notification-run";
const origin = { channel: "telegram", to: "synthetic-original-recipient" };
const nextOrigin = { channel: "telegram", to: "synthetic-current-recipient" };
const sent: MessageSendResult = {
  ...origin,
  via: "direct",
  mediaUrl: null,
  deliveryStatus: "sent",
  result: { messageId: "synthetic-notification" },
};
type MessageSendParams = Parameters<typeof SendMessage>[0];
let state: OpenClawTestState;
let notifications: Array<{ complete: () => void; result: Promise<TaskRecord | null> }>;
let nativeDeliveries: ReturnType<typeof captureTaskDeliveryWork> | undefined;

function createTask(parentFlowId?: string): TaskRecord {
  return createTaskFixture("cli", {
    ownerKey,
    requesterSessionKey: ownerKey,
    requesterAgentId: "main",
    requesterOrigin: origin,
    runId,
    task: "Synthetic state notification",
    notifyPolicy: "state_changes",
    deliveryStatus: "pending",
    lastEventAt: Date.now(),
    parentFlowId,
  });
}

function progress(at: number, summary = "Original progress"): TaskEventRecord {
  return { at, kind: "progress", summary };
}

function startNotification(task: TaskRecord, event: TaskEventRecord) {
  const dispatched = createDeferred<MessageSendParams>();
  const transport = createDeferred<MessageSendResult>();
  sendMessage.mockImplementationOnce(async (params) => {
    dispatched.resolve(params);
    return await transport.promise;
  });
  const result = maybeDeliverTaskStateChangeUpdate(task, event);
  const complete = () => transport.resolve(sent);
  notifications.push({ complete, result });
  return {
    result,
    complete,
    dispatched: Promise.race([
      dispatched.promise,
      result.then(() => {
        throw new Error("State notification settled before transport dispatch");
      }),
    ]),
  };
}

function stored(taskId: string) {
  const snapshot = loadTaskRegistryMutationStateFromSqlite([{ taskId }]);
  return { task: snapshot.tasks.get(taskId), delivery: snapshot.deliveryStates.get(taskId) };
}

function failPreparationAfterQueue(failure: Error) {
  const queued = vi.spyOn(systemEvents, "enqueueSystemEvent");
  failTaskNotificationPreparationAfterConsume(() => queued.mock.calls.length > 0, failure);
  return queued;
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "task-state-notification-",
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetGatewayWorkAdmission();
  notifications = [];
  nativeDeliveries = undefined;
  systemEvents.resetSystemEventsForTest();
  sendMessage.mockReset();
});

afterEach(async () => {
  for (const notification of notifications) {
    notification.complete();
  }
  await Promise.allSettled(notifications.map(({ result }) => result));
  try {
    await nativeDeliveries?.settle();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  } finally {
    nativeDeliveries?.[Symbol.dispose]();
    vi.restoreAllMocks();
  }
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetGatewayWorkAdmission();
  systemEvents.resetSystemEventsForTest();
  await state.cleanup();
});

describe("task state notification acknowledgements", () => {
  it("retains failure ownership when the database retires during preparation", async () => {
    const task = createTask();
    const before = stored(task.taskId);
    const entered = createDeferred();
    const release = createDeferred();
    vi.spyOn(taskRegistryListener, "captureTaskRegistryReadFence").mockImplementationOnce(
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    const warnings = vi.spyOn(taskRegistryState.taskRegistryLog, "warn");
    const result = maybeDeliverTaskStateChangeUpdate(task, progress(task.createdAt + 10));
    const outcome = result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    notifications.push({ complete: () => release.resolve(), result: outcome.then(() => null) });
    await entered.promise;
    await closeOpenClawStateDatabaseAsync();
    release.resolve();
    expect(await outcome).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }),
    });
    expect(warnings).toHaveBeenCalledExactlyOnceWith(
      "Background task notification failed",
      expect.objectContaining({
        taskId: task.taskId,
        error: expect.objectContaining({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(systemEvents.drainSystemEvents(ownerKey)).toEqual([]);
    expect(stored(task.taskId)).toEqual(before);
  });

  it("joins an accepted terminal event before selecting progress for delivery", async () => {
    const task = createTask();
    const admitted = createDeferred();
    const release = createDeferred();
    const store = getTaskRegistryStore();
    const mutate = store.runAgentEventMutationAsync.bind(store);
    vi.spyOn(store, "runAgentEventMutationAsync").mockImplementationOnce(async (...args) => {
      admitted.resolve();
      await release.promise;
      return mutate(...args);
    });
    sendMessage.mockResolvedValue(sent);
    nativeDeliveries = captureTaskDeliveryWork();
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: Date.now() } });
    await admitted.promise;
    const preparing = createDeferred();
    const captureReadFence = taskRegistryListener.captureTaskRegistryReadFence;
    vi.spyOn(taskRegistryListener, "captureTaskRegistryReadFence").mockImplementationOnce(
      (...args) => {
        const fence = captureReadFence(...args);
        preparing.resolve();
        return fence;
      },
    );
    const result = maybeDeliverTaskStateChangeUpdate(task, progress(task.createdAt + 10));
    notifications.push({ complete: () => release.resolve(), result });
    try {
      await preparing.promise;
      expect(sendMessage).not.toHaveBeenCalled();
      release.resolve();
      await taskRegistryListener.captureTaskRegistryReadFence(
        captureOpenClawStateWorkerContext().admission,
      );
      await result;
      await nativeDeliveries.settle();
      expect(stored(task.taskId).task?.status).toBe("succeeded");
      expect(
        sendMessage.mock.calls.every(([params]) => !params.content?.includes("Original progress")),
      ).toBe(true);
    } finally {
      release.resolve();
      await result;
    }
  });

  it.each([false, true])(
    "delivers and acknowledges with parent flow=%s without entering the host state coordinator",
    async (linked) => {
      const flow = linked
        ? createManagedTaskFlow({
            ownerKey,
            requesterOrigin: nextOrigin,
            goal: "Synthetic notification flow",
            controllerId: "tests/notification",
          })
        : undefined;
      const task = createTask(flow?.flowId);
      const acquire = vi
        .spyOn(stateCoordinator, "acquireStateDatabaseCoordinator")
        .mockImplementation(() => {
          throw new Error("Synthetic held host coordinator must not block notification delivery");
        });
      const notification = startNotification(task, progress(task.createdAt + 10));
      expect(await notification.dispatched).toMatchObject(linked ? nextOrigin : origin);
      notification.complete();
      expect(await notification.result).toMatchObject({ taskId: task.taskId });
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it("acknowledges a confirmed direct send without host task or delivery writes", async () => {
    const task = createTask();
    const warnings = vi.spyOn(taskRegistryState.taskRegistryLog, "warn");
    const event = progress(task.createdAt + 10);
    const notification = startNotification(task, event);
    expect(await notification.dispatched).toMatchObject({
      ...origin,
      content: expect.stringContaining("Original progress"),
    });
    const tracker = trackSqliteStatementExecutions(
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
    try {
      notification.complete();
      const result = await notification.result;
      const persisted = stored(task.taskId);
      expect(warnings.mock.calls).toEqual([]);
      expect(persisted.delivery).toEqual({
        taskId: task.taskId,
        requesterOrigin: origin,
        lastNotifiedEventAt: event.at,
      });
      expect(result).toEqual(persisted.task);
      expect(result).toMatchObject({ status: "running", deliveryStatus: "pending" });
      expect(result?.lastEventAt).toBeGreaterThanOrEqual(task.lastEventAt ?? task.createdAt);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(tracker.counts).toEqual({ task: 0, delivery: 0 });
    } finally {
      tracker.restore();
    }
  });

  it("keeps a committed acknowledgement when publication fails without replaying delivery", async () => {
    const task = createTask();
    const event = progress(task.createdAt + 10);
    const notification = startNotification(task, event);
    await notification.dispatched;
    const store = getTaskRegistryStore();
    const mutations = vi.spyOn(store, "runInitialMutationAsync");
    const failure = new Error("Synthetic acknowledgement publication failure");
    const read = vi.spyOn(store, "loadMutationSnapshotAsync").mockRejectedValueOnce(failure);
    notification.complete();
    const result = await notification.result;
    expect(result).toEqual(stored(task.taskId).task);
    expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(event.at);
    expect(read).toHaveBeenCalledOnce();
    await maybeDeliverTaskStateChangeUpdate(task, event);
    expect(getTaskDeliveryState(task.taskId)?.lastNotifiedEventAt).toBe(event.at);
    expect(mutations).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(systemEvents.drainSystemEvents(ownerKey)).toEqual([]);
  });

  it("acknowledges the sent event when its caller mutates the event while transport waits", async () => {
    const task = createTask();
    const event = progress(task.createdAt + 10);
    const sentAt = event.at;
    const notification = startNotification(task, event);
    expect((await notification.dispatched).content).toContain("Original progress");
    event.at += 1_000;
    event.summary = "Unsent replacement progress";
    notification.complete();
    await notification.result;
    expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(sentAt);
    expect(getTaskDeliveryState(task.taskId)?.lastNotifiedEventAt).toBe(sentAt);
  });

  it("keeps the newest watermark and current origin when sends acknowledge out of order", async () => {
    const task = createTask();
    const earlierEvent = progress(task.createdAt + 10, "Earlier progress");
    const laterEvent = progress(task.createdAt + 20, "Later progress");
    const earlier = startNotification(task, earlierEvent);
    await earlier.dispatched;
    const later = startNotification(task, laterEvent);
    await later.dispatched;

    const laterAckStartedAt = Date.now();
    later.complete();
    await later.result;
    const afterLater = stored(task.taskId);
    expect(afterLater).toMatchObject({
      delivery: { lastNotifiedEventAt: laterEvent.at },
    });
    const laterAckAt = afterLater.task?.lastEventAt;
    expect(laterAckAt).toBeGreaterThanOrEqual(laterAckStartedAt);
    if (laterAckAt === undefined) {
      throw new Error("Expected the acknowledged task timestamp");
    }
    commitTaskDeliveryFixture({
      ...getTaskDeliveryState(task.taskId),
      taskId: task.taskId,
      requesterOrigin: nextOrigin,
    });

    const earlierAckStartedAt = Date.now();
    earlier.complete();
    await earlier.result;
    const afterEarlier = stored(task.taskId);
    expect(afterEarlier).toMatchObject({
      task: { status: "running", deliveryStatus: "pending" },
      delivery: { requesterOrigin: nextOrigin, lastNotifiedEventAt: laterEvent.at },
    });
    expect(afterEarlier.task?.lastEventAt).toBeGreaterThanOrEqual(earlierAckStartedAt);
    expect(afterEarlier.task?.lastEventAt).toBeGreaterThanOrEqual(laterAckAt);
    expect(getTaskDeliveryState(task.taskId)).toEqual(afterEarlier.delivery);
    await maybeDeliverTaskStateChangeUpdate(task, earlierEvent);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("retains a sent receipt when the same task gains a replacement run owner", async () => {
    const task = createTask();
    const releaseOriginal = bindTaskRunOwner(task, async () => err("Original run"));
    let releaseSuccessor: (() => void) | undefined;
    try {
      const event = progress(task.createdAt + 10);
      const notification = startNotification(task, event);
      await notification.dispatched;
      releaseSuccessor = bindTaskRunOwner(task, async () => err("Successor run"));
      const successor = getTaskRunOwner(task);
      expect(successor).toBeDefined();
      releaseOriginal();
      notification.complete();
      await notification.result;
      expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(event.at);
      expect(getTaskRunOwner(task)).toBe(successor);
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      releaseOriginal();
      releaseSuccessor?.();
    }
  });

  it("binds the caller event before preparation yields", async () => {
    const task = createTask();
    const event = progress(task.createdAt + 10);
    const originalAt = event.at;
    const notification = startNotification(task, event);
    event.at += 1_000;
    event.summary = "Never requested progress";
    expect((await notification.dispatched).content).toContain("Original progress");
    notification.complete();
    await notification.result;
    expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(originalAt);
  });

  it("retains the receipt when lifecycle normalization backdates the same task", async () => {
    const task = createTask();
    const event = progress(task.createdAt + 10);
    const notification = startNotification(task, event);
    await notification.dispatched;
    nativeDeliveries = captureTaskDeliveryWork();
    markTaskRunningByRunId({
      taskId: task.taskId,
      runId,
      startedAt: task.createdAt - 1_000,
    });
    expect(stored(task.taskId).task?.createdAt).toBe(task.createdAt - 1_000);
    notification.complete();
    await notification.result;
    await nativeDeliveries.settle();
    expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(event.at);
  });

  it("joins a queued event ACK before preparing a repeated notification", async () => {
    const task = createTask();
    commitTaskDeliveryFixture({ taskId: task.taskId });
    const enqueue = systemEvents.enqueueSystemEvent;
    const consumed: string[] = [];
    const queued = vi.spyOn(systemEvents, "enqueueSystemEvent").mockImplementation((...args) => {
      const result = enqueue(...args);
      consumed.push(...systemEvents.drainSystemEvents(ownerKey));
      return result;
    });
    const event = progress(task.createdAt + 10);
    const first = maybeDeliverTaskStateChangeUpdate(task, event);
    const second = maybeDeliverTaskStateChangeUpdate(task, event);
    const results = await Promise.all([first, second]);
    expect(queued).toHaveBeenCalledOnce();
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toContain("Original progress");
    expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(event.at);
    expect(results[0]).toEqual(results[1]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["initial", "fresh"] as const)(
    "settles the queued ACK before reporting %s preparation cleanup failure",
    async (phase) => {
      const task = createTask();
      const event = progress(task.createdAt + 10);
      if (phase === "initial") {
        commitTaskDeliveryFixture({ taskId: task.taskId });
      } else {
        const load = deliveryRuntime.deliveryRuntimeLoader.load;
        vi.spyOn(deliveryRuntime.deliveryRuntimeLoader, "load").mockImplementationOnce(async () => {
          const runtime = await load();
          commitTaskDeliveryFixture({ taskId: task.taskId });
          return runtime;
        });
      }
      const cleanupFailure = new Error("Synthetic post-queue preparation cleanup failure");
      const queued = failPreparationAfterQueue(cleanupFailure);
      const warnings = vi.spyOn(taskRegistryState.taskRegistryLog, "warn");
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const ackStarted = createDeferred();
      const releaseAck = createDeferred();
      const mutations = vi
        .spyOn(store, "runInitialMutationAsync")
        .mockImplementation(async (context, command, assertCurrent) => {
          if (command.type === "tasks.acknowledgeStateChange") {
            ackStarted.resolve();
            await releaseAck.promise;
          }
          return mutate(context, command, assertCurrent);
        });
      const pending = maybeDeliverTaskStateChangeUpdate(task, event);
      notifications.push({ complete: () => releaseAck.resolve(), result: pending });
      let finished = false;
      const outcome = pending
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
            ackStarted.promise.then(() => "ack_started"),
            outcome.then(() => "settled"),
          ]),
        ).toBe("ack_started");
        expect(finished).toBe(false);
        expect(queued).toHaveBeenCalledOnce();
        const releasedAt = Date.now();
        releaseAck.resolve();
        const result = await outcome;
        const persisted = stored(task.taskId);
        expect(persisted.delivery?.lastNotifiedEventAt).toBe(event.at);
        expect(persisted.task?.lastEventAt).toBeGreaterThanOrEqual(releasedAt);
        expect(getTaskById(task.taskId)).toEqual(persisted.task);
        if (phase === "initial") {
          expect(result).toEqual({ ok: false, error: cleanupFailure });
        } else {
          expect(result).toEqual({ ok: true, value: persisted.task });
          expect(warnings.mock.calls.some(([, meta]) => meta?.error === cleanupFailure)).toBe(true);
        }
        expect(mutations).toHaveBeenCalledOnce();
        expect(systemEvents.drainSystemEvents(ownerKey)).toEqual([
          expect.stringContaining("Original progress"),
        ]);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        releaseAck.resolve();
        await outcome;
      }
    },
  );

  it("preserves both preparation cleanup and queued ACK failures", async () => {
    const task = createTask();
    commitTaskDeliveryFixture({ taskId: task.taskId });
    const before = stored(task.taskId);
    const cleanupFailure = new Error("Synthetic queued preparation cleanup failure");
    const ackFailure = new Error("Synthetic queued acknowledgement failure");
    const queued = failPreparationAfterQueue(cleanupFailure);
    const mutations = vi
      .spyOn(getTaskRegistryStore(), "runInitialMutationAsync")
      .mockRejectedValueOnce(ackFailure);
    const pending = maybeDeliverTaskStateChangeUpdate(task, progress(task.createdAt + 10));
    notifications.push({ complete() {}, result: pending });
    const outcome = await pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (outcome.ok || !(outcome.error instanceof AggregateError)) {
      throw new Error("Expected cleanup and acknowledgement failures to remain aggregated");
    }
    expect(outcome.error.errors).toEqual([cleanupFailure, ackFailure]);
    expect(outcome.error.cause).toBe(cleanupFailure);
    expect(stored(task.taskId)).toEqual(before);
    expect(queued).toHaveBeenCalledOnce();
    expect(mutations).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["watermark", "task"] as const)(
    "preserves separate best-effort persistence when the %s write fails",
    async (stage) => {
      const task = createTask();
      // Open the canonical worker before injecting a statement failure into its live connection.
      const warmup = startNotification(task, progress(task.createdAt + 1));
      await warmup.dispatched;
      warmup.complete();
      await warmup.result;
      const event = progress(task.createdAt + 10);
      const notification = startNotification(task, event);
      await notification.dispatched;
      const before = stored(task.taskId);
      const db = openOpenClawStateDatabase().db;
      const target =
        stage === "watermark" ? "INSERT ON task_delivery_state" : "UPDATE ON task_runs";
      const condition =
        stage === "watermark" ? `WHEN NEW.last_notified_event_at > ${task.createdAt + 1}` : "";
      // A persistent trigger also applies to the worker's independent connection.
      db.exec(`CREATE TRIGGER reject_notification_ack BEFORE ${target}
        ${condition} BEGIN SELECT RAISE(ABORT, 'synthetic ACK write failure'); END;`);
      try {
        notification.complete();
        const result = await notification.result;
        const after = stored(task.taskId);
        if (stage === "watermark") {
          expect(after.delivery).toEqual(before.delivery);
          expect(after.task?.lastEventAt).toBeGreaterThan(
            before.task?.lastEventAt ?? task.createdAt,
          );
          expect(result).toEqual(after.task);
          expect(result).not.toBeNull();
        } else {
          expect(after.task).toEqual(before.task);
          expect(after.delivery?.lastNotifiedEventAt).toBe(event.at);
          expect(getTaskDeliveryState(task.taskId)).toEqual(after.delivery);
          expect(result).toBeNull();
        }
        expect(sendMessage).toHaveBeenCalledTimes(2);
      } finally {
        db.exec("DROP TRIGGER reject_notification_ack");
      }
    },
  );

  it("records accepted delivery during drain but refuses an obsolete Gateway continuation", async () => {
    const task = createTask();
    const firstEvent = progress(task.createdAt + 10);
    const first = startNotification(task, firstEvent);
    await first.dispatched;
    markGatewayRestartDraining();
    first.complete();
    await first.result;
    expect(stored(task.taskId).delivery?.lastNotifiedEventAt).toBe(firstEvent.at);
    resetGatewayWorkAdmission();
    const second = startNotification(task, progress(firstEvent.at + 10));
    await second.dispatched;
    const before = stored(task.taskId);
    resetGatewayWorkAdmission();
    second.complete();
    await second.result;
    expect(stored(task.taskId)).toEqual(before);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps a native producer's receipt when its publication observer replaces the resident run", async () => {
    const task = createTask();
    const replacement: TaskRecord = {
      ...task,
      runId: "replacement-during-publication",
      task: "Replacement installed by the publication observer",
    };
    const delivery = {
      taskId: task.taskId,
      requesterOrigin: nextOrigin,
      lastNotifiedEventAt: 0,
    };
    let replaced = false;
    const stop = onTaskRegistryChange(() => {
      const current = taskRegistryState.tasks.get(task.taskId);
      if (replaced || current?.progressSummary !== "Producer progress") {
        return;
      }
      replaced = true;
      upsertTaskWithDeliveryStateToSqlite({ task: replacement, deliveryState: delivery });
      publishTaskRecordAfterAtomicStore(replacement);
      commitTaskDeliveryFixture(delivery);
    });
    sendMessage.mockResolvedValue(sent);
    nativeDeliveries = captureTaskDeliveryWork();
    try {
      const [receipt] = markTaskRunningByRunId({
        runId,
        progressSummary: "Producer progress",
        eventSummary: "Producer progress",
      });
      expect(receipt?.runId).toBe(task.runId);
      expect(replaced).toBe(true);
      const before = stored(task.taskId);
      expect(before.task?.runId).toBe(replacement.runId);
      await nativeDeliveries.settle();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(systemEvents.drainSystemEvents(ownerKey)).toEqual([]);
      expect(stored(task.taskId)).toEqual(before);
    } finally {
      stop();
    }
  });

  it.each(["direct", "queued"] as const)(
    "does not retarget a prepared event to a replacement run's %s delivery",
    async (delivery) => {
      const task = createTask();
      const event = progress(task.createdAt + 10);
      const loading = createDeferred();
      const release = createDeferred();
      const load = deliveryRuntime.deliveryRuntimeLoader.load;
      vi.spyOn(deliveryRuntime.deliveryRuntimeLoader, "load").mockImplementationOnce(async () => {
        loading.resolve();
        await release.promise;
        return await load();
      });
      sendMessage.mockResolvedValue(sent);
      const result = maybeDeliverTaskStateChangeUpdate(task, event);
      notifications.push({ complete: () => release.resolve(), result });
      try {
        expect(
          await Promise.race([loading.promise.then(() => "loading"), result.then(() => "settled")]),
        ).toBe("loading");
        const replacement: TaskRecord = {
          ...task,
          runId: "replacement-before-send",
          task: "Unrelated replacement task",
        };
        const replacementDelivery = {
          taskId: task.taskId,
          ...(delivery === "direct" ? { requesterOrigin: nextOrigin } : {}),
          lastNotifiedEventAt: event.at - 1,
        };
        upsertTaskWithDeliveryStateToSqlite({
          task: replacement,
          deliveryState: replacementDelivery,
        });
        publishTaskRecordAfterAtomicStore(replacement);
        commitTaskDeliveryFixture(replacementDelivery);
        const before = stored(task.taskId);
        release.resolve();
        const completed = await result;
        expect(sendMessage).not.toHaveBeenCalled();
        expect(systemEvents.drainSystemEvents(ownerKey)).toEqual([]);
        expect(completed).toEqual(before.task);
        expect(stored(task.taskId)).toEqual(before);
        expect(getTaskById(task.taskId)).toEqual(before.task);
        expect(getTaskDeliveryState(task.taskId)).toEqual(before.delivery);
      } finally {
        release.resolve();
        await result;
      }
    },
  );

  it.each(["deleted", "replaced"] as const)(
    "does not apply an old acknowledgement to a %s task identity",
    async (change) => {
      const task = createTask();
      const event = progress(task.createdAt + 10);
      const notification = startNotification(task, event);
      await notification.dispatched;
      if (change === "replaced") {
        const replacement: TaskRecord = {
          ...task,
          runId: "replacement-run",
          createdAt: task.createdAt + 1,
          lastEventAt: task.createdAt + 1,
          task: "Replacement task identity",
        };
        const delivery = {
          taskId: task.taskId,
          requesterOrigin: nextOrigin,
          lastNotifiedEventAt: event.at - 1,
        };
        upsertTaskWithDeliveryStateToSqlite({ task: replacement, deliveryState: delivery });
        publishTaskRecordAfterAtomicStore(replacement);
        commitTaskDeliveryFixture(delivery);
      } else {
        const expired = updateTask(task.taskId, { status: "succeeded", cleanupAfter: 0 });
        if (!expired) {
          throw new Error("Expected the terminal task before retention");
        }
        expect(
          await applyTaskRegistryMaintenanceRetention(expired, Date.now(), new Map(), () => {}),
        ).toBe("pruned");
      }
      const beforeAck = stored(task.taskId);
      notification.complete();
      await notification.result;
      expect(stored(task.taskId)).toEqual(beforeAck);
      expect(getTaskById(task.taskId)).toEqual(beforeAck.task);
      expect(getTaskDeliveryState(task.taskId)).toEqual(beforeAck.delivery);
      expect(sendMessage).toHaveBeenCalledOnce();
    },
  );
});
