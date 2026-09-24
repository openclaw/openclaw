import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import type { MessageSendResult } from "../infra/outbound/message.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as deliveryRuntime from "./task-registry-delivery-runtime.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { invalidateTaskRegistryProjection, taskRegistryLog, tasks } from "./task-registry-state.js";
import { recordTaskProgressByRunId } from "./task-registry.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture, finishTaskFixture } from "./task-registry.test-support.js";
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
});

async function joinEvents() {
  await setImmediate();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
}

it.each(["state", "terminal"] as const)(
  "delivers %s notification after concurrent publications invalidate prepared snapshots",
  async (kind) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const origin = { channel: "telegram", to: "synthetic-contended-recipient" };
      const eventAt = Date.now();
      const task = createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterOrigin: origin,
        runId: `contended-notification-${kind}`,
        task: "Notification during publication contention",
        notifyPolicy: kind === "state" ? "state_changes" : "done_only",
        deliveryStatus: "pending",
        lastEventAt: eventAt,
      });
      if (kind === "terminal") {
        finishTaskFixture({ taskId: task.taskId, status: "succeeded", endedAt: eventAt });
      }
      await prepareTaskRegistryRead();
      const store = getTaskRegistryStore();
      const read = store.loadMutationSnapshotAsync.bind(store);
      let invalidations = 4;
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await read(...args);
        if (invalidations > 0) {
          invalidations -= 1;
          invalidateTaskRegistryProjection();
        }
        return snapshot;
      });
      const sent: MessageSendResult = {
        ...origin,
        via: "direct",
        mediaUrl: null,
        deliveryStatus: "sent",
        result: { messageId: "synthetic-contended-message" },
      };
      const sendMessage = vi.spyOn(deliveryRuntime, "sendMessage").mockResolvedValue(sent);
      using deliveries = captureTaskDeliveryWork();
      try {
        invalidateTaskRegistryProjection();
        await (kind === "state"
          ? maybeDeliverTaskStateChangeUpdate(task, {
              kind: "progress",
              at: eventAt,
              summary: "Progress during publication contention",
            })
          : maybeDeliverTaskTerminalUpdate(task.taskId));
        await deliveries.settle();
        expect(invalidations).toBe(0);
        expect(sendMessage).toHaveBeenCalledOnce();
        const durable = loadTaskRegistryStateFromSqliteReadOnly();
        if (kind === "state") {
          expect(durable.deliveryStates.get(task.taskId)?.lastNotifiedEventAt).toBe(eventAt);
        } else {
          expect(durable.tasks.get(task.taskId)?.deliveryStatus).toBe("delivered");
        }
      } finally {
        await Promise.allSettled([deliveries.settle()]);
        await joinEvents();
      }
    });
  },
);

it.each(["start", "end"] as const)(
  "delivers published %s after its accepted prefix while retaining independent cleanup roots",
  async (phase) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const origin = { channel: "telegram", to: "synthetic-publication-recipient" };
      const task = createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterOrigin: origin,
        runId: `publication-lifetime-${phase}`,
        task: "Published notification",
        status: phase === "start" ? "queued" : "running",
        notifyPolicy: phase === "start" ? "state_changes" : "done_only",
        deliveryStatus: "pending",
      });
      const sibling = createTaskFixture("cli", {
        runId: `publication-prefix-${phase}`,
        task: "Accepted before notification preparation",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      const eventEntered = createDeferred();
      const releaseEvent = createDeferred();
      const siblingEntered = createDeferred();
      const releaseSibling = createDeferred();
      const producerCleanup = createDeferred();
      const transportCleanup = createDeferred();
      const sendEntered = createDeferred();
      let producerSignal: AbortSignal | undefined;
      let deliverySignal: AbortSignal | undefined;
      let producerCleanupWork: Promise<void> | undefined;
      let transportCleanupWork: Promise<void> | undefined;
      const writes = vi
        .spyOn(store, "runAgentEventMutationAsync")
        .mockImplementation(async (...args) => {
          if (args[1].taskId === task.taskId) {
            producerSignal = getAsyncWorkSignal();
            producerCleanupWork = trackAsyncWork(() => producerCleanup.promise);
            eventEntered.resolve();
            await releaseEvent.promise;
          } else if (args[1].taskId === sibling.taskId) {
            siblingEntered.resolve();
            await releaseSibling.promise;
          }
          return await mutate(...args);
        });
      const sent: MessageSendResult = {
        ...origin,
        via: "direct",
        mediaUrl: null,
        deliveryStatus: "sent",
        result: { messageId: "synthetic-publication-message" },
      };
      const sendMessage = vi.fn(async () => {
        deliverySignal = getAsyncWorkSignal();
        transportCleanupWork = trackAsyncWork(() => transportCleanup.promise);
        sendEntered.resolve();
        return sent;
      });
      vi.spyOn(deliveryRuntime, "sendMessage").mockImplementation(sendMessage);
      using deliveries = captureTaskDeliveryWork();
      try {
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data:
            phase === "start" ? { phase, startedAt: Date.now() } : { phase, endedAt: Date.now() },
        });
        emitAgentEvent({
          runId: sibling.runId!,
          stream: "tool",
          data: { phase: "start", name: "accepted-prefix" },
        });
        await eventEntered.promise;
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        releaseEvent.resolve();
        expect(
          await Promise.race([
            siblingEntered.promise.then(() => "sibling waiting"),
            sendEntered.promise.then(() => "notification sent"),
          ]),
        ).toBe("sibling waiting");
        await setImmediate();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(
          loadTaskRegistryStateFromSqliteReadOnly().tasks.get(sibling.taskId)?.toolUseCount ?? 0,
        ).toBe(0);
        expect(tasks.get(task.taskId)?.status).toBe(phase === "start" ? "running" : "succeeded");

        releaseSibling.resolve();
        await withTestTimeout(
          deliveries.settle(),
          2_000,
          "Published notification joined its producer or transport cleanup",
        );
        expect(writes).toHaveBeenCalledTimes(2);
        expect(sendMessage).toHaveBeenCalledOnce();
        const durable = loadTaskRegistryStateFromSqliteReadOnly();
        expect(durable.tasks.get(sibling.taskId)?.toolUseCount).toBe(1);
        if (phase === "start") {
          expect(durable.deliveryStates.get(task.taskId)?.lastNotifiedEventAt).toBeGreaterThan(0);
        } else {
          expect(durable.tasks.get(task.taskId)?.deliveryStatus).toBe("delivered");
        }
        expect(producerSignal).toBeDefined();
        expect(deliverySignal).toBeDefined();
        expect(deliverySignal).not.toBe(producerSignal);
        expect(producerSignal?.aborted).toBe(false);
        expect(deliverySignal?.aborted).toBe(false);
        await setImmediate();
        expect(getActiveGatewayRootWorkCount()).toBe(2);

        producerCleanup.resolve();
        await producerCleanupWork;
        await setImmediate();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(producerSignal?.aborted).toBe(true);
        expect(deliverySignal?.aborted).toBe(false);
        transportCleanup.resolve();
        await transportCleanupWork;
        await joinEvents();
        expect(deliverySignal?.aborted).toBe(true);
      } finally {
        releaseEvent.resolve();
        releaseSibling.resolve();
        producerCleanup.resolve();
        transportCleanup.resolve();
        await deliveries.settle();
        await joinEvents();
      }
    });
  },
);

it("reports retired background notification reads without sending or losing their rejected outcomes", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const task = createTaskFixture("cli", {
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterOrigin: { channel: "telegram", to: "synthetic-retired-notification" },
      runId: "retired-background-notification",
      task: "Publish progress before storage retires",
      status: "running",
      notifyPolicy: "state_changes",
      deliveryStatus: "pending",
    });
    const store = getTaskRegistryStore();
    const read = store.loadMutationSnapshotAsync.bind(store);
    const entered = createDeferred();
    const release = createDeferred();
    const sendMessage = vi.fn();
    const report = vi.spyOn(taskRegistryLog, "warn").mockImplementation(() => {});
    vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
      const snapshot = await read(...args);
      entered.resolve();
      await release.promise;
      return snapshot;
    });
    vi.spyOn(deliveryRuntime, "sendMessage").mockImplementation(sendMessage);
    using deliveries = captureTaskDeliveryWork();
    try {
      recordTaskProgressByRunId({ runId: task.runId!, progressSummary: "Captured progress" });
      invalidateTaskRegistryProjection();
      await entered.promise;
      await withTestTimeout(
        closeOpenClawStateDatabaseAsync(),
        5_000,
        "Retire the completed read owner",
      );
      release.resolve();
      await expect(deliveries.settle()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [
          expect.objectContaining({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }),
          expect.objectContaining({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }),
        ],
      });
      await setImmediate();
      expect(
        report.mock.calls.filter(([message]) => message === "Background task notification failed"),
      ).toEqual([
        [
          "Background task notification failed",
          {
            taskId: task.taskId,
            error: expect.objectContaining({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }),
          },
        ],
        [
          "Background task notification failed",
          {
            taskId: task.taskId,
            error: expect.objectContaining({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }),
          },
        ],
      ]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const stored = await read(captureOpenClawStateWorkerContext(), { taskId: task.taskId });
      expect(stored.tasks.get(task.taskId)).toMatchObject({
        status: "running",
        deliveryStatus: "pending",
      });
      expect(stored.deliveryStates.get(task.taskId)?.lastNotifiedEventAt).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([deliveries.settle()]);
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
