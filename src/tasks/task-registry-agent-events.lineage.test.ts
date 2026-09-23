import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainTaskAgentEventLineage } from "./task-registry-agent-event-lineage.js";
import * as taskDelivery from "./task-registry-delivery.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { prepareTaskRegistryRead, prepareTaskRegistryReadOwner } from "./task-registry-read.js";
import { captureTaskPersistenceReceipt } from "./task-registry-records.js";
import * as taskRegistryState from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture, prepareTaskFixtureRead } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

let deliveries: ReturnType<typeof captureTaskDeliveryWork>;
beforeEach(() => {
  deliveries = captureTaskDeliveryWork();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});

async function joinEvents() {
  // Scenario assertions own accepted-event errors; join that prefix before its notifications.
  await Promise.allSettled([
    captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission),
  ]);
  await deliveries.settle();
  await setImmediate();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
}

function emitTool(runId: string, name: string) {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name } });
}

describe("task agent event lineage", () => {
  it.each([
    "after publication",
    "during readback",
    "during readback without terminal",
    "after settled replacement",
    "after settled replacement before result",
    "after replacement before first settlement",
    "after replacement before first result",
  ] as const)(
    "retains normalized start lineage and accepted terminal fences %s",
    async (scenario) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "normalized-publication",
          task: "Preserve the accepted terminal",
          status: "queued",
          startedAt: 1_000,
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const replaced = scenario.includes("replacement");
        const terminalQueued = !replaced && scenario !== "during readback without terminal";
        const started = createDeferred();
        let replacementCommitted = false;
        let emitted = false;
        const emitAfterStart = (current: ReturnType<typeof getTaskById>) => {
          if (!emitted && current?.startedAt === (replaced ? 1_000 : 0)) {
            emitted = true;
            emitTool(task.runId!, "successor");
            started.resolve();
          }
        };
        const stop = onTaskRegistryChange(() => {
          if (scenario === "after publication") {
            emitAfterStart(taskRegistryState.tasks.get(task.taskId));
          }
        });
        if (scenario !== "after publication") {
          const store = getTaskRegistryStore();
          if (replaced) {
            const mutate = store.runAgentEventMutationAsync.bind(store);
            vi.spyOn(store, "runAgentEventMutationAsync").mockImplementationOnce(
              async (...args) => {
                const receipt = await mutate(...args);
                if (scenario.startsWith("after settled")) {
                  expect(getTaskById(task.taskId)?.startedAt).toBe(0);
                }
                for (const record of [{ ...task, task: "Intervening replacement" }, task]) {
                  store.upsertTaskWithDeliveryState({ task: record });
                  publishTaskRecordAfterAtomicStore(record);
                }
                replacementCommitted = true;
                if (scenario.endsWith("result")) {
                  emitAfterStart(taskRegistryState.tasks.get(task.taskId));
                }
                return receipt;
              },
            );
          }
          const read = store.loadMutationSnapshotAsync.bind(store);
          vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
            const snapshot = await read(...args);
            if (
              !emitted &&
              (!replaced || replacementCommitted) &&
              snapshot.tasks.get(task.taskId)?.startedAt === (replaced ? 1_000 : 0)
            ) {
              expect(taskRegistryState.tasks.get(task.taskId)?.startedAt).toBe(1_000);
              emitAfterStart(snapshot.tasks.get(task.taskId));
            }
            return snapshot;
          });
        }
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 0 },
          });
          if (terminalQueued) {
            emitAgentEvent({
              runId: task.runId!,
              stream: "lifecycle",
              data: { phase: "end", endedAt: 2_000 },
            });
          }
          await started.promise;
          await joinEvents();
          const current = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          expect(current).toMatchObject({
            status: terminalQueued ? "succeeded" : replaced ? "queued" : "running",
            startedAt: replaced ? 1_000 : 0,
          });
          expect(current?.endedAt).toBe(terminalQueued ? 2_000 : undefined);
          expect(current?.toolUseCount ?? 0).toBe(terminalQueued ? 0 : 1);
          expect(current?.lastToolName).toBe(terminalQueued ? undefined : "successor");
        } finally {
          stop();
        }
      });
    },
  );
});

describe("task agent event preparation", () => {
  it("persists a warm accepted event with only its publication snapshot", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "warm-event-preparation",
        task: "Prepare before invalidating",
        status: "queued",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = await prepareTaskFixtureRead(task);
      const reads = vi.spyOn(store, "loadMutationSnapshotAsync");
      const writes = vi.spyOn(store, "runAgentEventMutationAsync");
      const startedAt = task.createdAt;
      const published = vi.fn();
      const stop = onTaskRegistryChange((event) => {
        if (event?.kind === "upserted" && event.task.taskId === task.taskId && event.previous) {
          published(event);
        }
      });
      try {
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "start", startedAt },
        });
        await joinEvents();
        const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(durable).toMatchObject({ status: "running", startedAt });
        expect(taskRegistryState.tasks.get(task.taskId)).toEqual(durable);
        expect(published).toHaveBeenCalledOnce();
        expect(published).toHaveBeenCalledWith(
          expect.objectContaining({
            previous: expect.objectContaining({ status: "queued" }),
            task: expect.objectContaining({ status: "running", startedAt }),
          }),
        );
        expect(writes).toHaveBeenCalledOnce();
        expect(reads).toHaveBeenCalledOnce();
      } finally {
        stop();
      }
    });
  });

  it.each(["commit", "rollback"] as const)(
    "joins an in-flight preparation read without retrying after native %s",
    async (outcome) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          requesterSessionKey: "agent:main:main",
          runId: `consumed-during-snapshot-${outcome}`,
          task: "Settle native work before releasing the event fence",
          status: "queued",
          notifyPolicy: "state_changes",
          deliveryStatus: "pending",
        });
        const store = await prepareTaskFixtureRead(task);
        const readSnapshot = store.loadMutationSnapshotAsync.bind(store);
        const entered = createDeferred();
        const release = createDeferred();
        const failure = new Error("Synthetic native rollback during projection read");
        const writes = vi.spyOn(store, "runAgentEventMutationAsync");
        vi.spyOn(taskRegistryState.taskRegistryLog, "warn").mockImplementation(() => {});
        let projectionReads = 0;
        const readsBeforeNotifications: number[] = [];
        const notify = taskDelivery.maybeDeliverTaskStateChangeUpdate;
        vi.spyOn(taskDelivery, "maybeDeliverTaskStateChangeUpdate").mockImplementation(
          (...args) => {
            readsBeforeNotifications.push(projectionReads);
            return notify(...args);
          },
        );
        vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
          const snapshot = await readSnapshot(...args);
          if (args[1] === undefined && ++projectionReads === 1) {
            entered.resolve();
            await release.promise;
          }
          return snapshot;
        });
        let fenceSettled = false;
        let fence: Promise<unknown> | undefined;
        const onCommitted = vi.fn();
        const closeLineage = retainTaskAgentEventLineage(
          captureOpenClawStateWorkerContext().admission,
          task.runId!,
          onCommitted,
        );
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "start", startedAt: task.createdAt - 1_000 },
          });
          taskRegistryState.invalidateTaskRegistryProjection();
          await withTestTimeout(entered.promise, 5_000, "Projection read did not begin");
          fence = prepareTaskRegistryReadOwner().then(
            () => {
              fenceSettled = true;
            },
            (error: unknown) => {
              fenceSettled = true;
              return error;
            },
          );
          const consume = () =>
            runOpenClawStateWriteTransaction(() => {
              expect(getTaskById(task.taskId)?.status).toBe("running");
              expect(peekSystemEvents(task.ownerKey)).toEqual([]);
              if (outcome === "rollback") {
                throw failure;
              }
            });
          if (outcome === "rollback") {
            expect(consume).toThrow(failure);
          } else {
            consume();
          }
          // Force the held pre-consumption snapshot to require another read if
          // preparation keeps retrying after its event lost write ownership.
          taskRegistryState.invalidateTaskRegistryProjection();
          await Promise.resolve();
          expect(fenceSettled).toBe(false);
        } finally {
          release.resolve();
          await joinEvents();
          closeLineage();
        }
        expect(await fence).toBe(outcome === "rollback" ? failure : undefined);
        if (outcome === "commit") {
          expect(onCommitted).toHaveBeenCalledExactlyOnceWith(captureTaskPersistenceReceipt(task), {
            ...captureTaskPersistenceReceipt(task),
            createdAt: task.createdAt - 1_000,
          });
        } else {
          expect(onCommitted).not.toHaveBeenCalled();
        }
        // Delivery starts after event settlement and owns any later projection preparation.
        expect(readsBeforeNotifications).toEqual(outcome === "commit" ? [1] : []);
        expect(readsBeforeNotifications[0] ?? projectionReads).toBe(1);
        expect(writes).not.toHaveBeenCalled();
        const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(durable).toMatchObject({
          status: outcome === "commit" ? "running" : "queued",
          runId: task.runId,
        });
        expect(peekSystemEvents(task.ownerKey)).toHaveLength(outcome === "commit" ? 1 : 0);
        const read = await prepareTaskRegistryRead();
        expect(read?.isTaskSettled(task.taskId)).toBe(true);
        expect(read?.getTaskById(task.taskId)).toEqual(durable);
        const committedCount = onCommitted.mock.calls.length;
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "start", startedAt: task.createdAt - 2_000 },
        });
        await joinEvents();
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.createdAt).toBe(
          task.createdAt - 2_000,
        );
        expect(onCommitted).toHaveBeenCalledTimes(committedCount);
      });
    },
  );

  it.each([
    "native commit",
    "native rollback",
    "task replacement",
    "store replacement",
    "lifecycle rotation",
    "preparation failure",
  ] as const)("settles accepted work across %s during preparation", async (scenario) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        runId: "held-event-preparation",
        task: "Retain accepted ownership",
        status: "queued",
        notifyPolicy: "state_changes",
        deliveryStatus: "pending",
      });
      const store = getTaskRegistryStore();
      const writes = vi.spyOn(store, "runAgentEventMutationAsync");
      const warning = vi
        .spyOn(taskRegistryState.taskRegistryLog, "warn")
        .mockImplementation(() => {});
      const owner = taskRegistryState.taskFlowSyncOwner(task.taskId);
      const entered = createDeferred();
      const release = createDeferred();
      const failure = new Error(`Synthetic ${scenario}`);
      vi.spyOn(taskRegistryState, "taskFlowSyncOwner").mockReturnValueOnce({
        ...owner,
        async prepare(...args) {
          const prepared = await owner.prepare(...args);
          entered.resolve();
          await release.promise;
          return prepared;
        },
      });
      let rejectPreparation = false;
      let fenceSettled = false;
      let fence: Promise<unknown> | undefined;
      try {
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "start", startedAt: task.createdAt + 1 },
        });
        await withTestTimeout(entered.promise, 5_000, "Event preparation did not begin");
        rejectPreparation = scenario === "preparation failure";
        fence = prepareTaskRegistryReadOwner().then(
          () => {
            fenceSettled = true;
            return undefined;
          },
          (error: unknown) => {
            fenceSettled = true;
            return error;
          },
        );
        await Promise.resolve();
        expect(fenceSettled).toBe(false);
        if (scenario === "native commit" || scenario === "native rollback") {
          const consume = () =>
            runOpenClawStateWriteTransaction(() => {
              expect(getTaskById(task.taskId)?.status).toBe("running");
              expect(peekSystemEvents(task.ownerKey)).toEqual([]);
              if (scenario === "native rollback") {
                throw failure;
              }
            });
          if (scenario === "native rollback") {
            expect(consume).toThrow(failure);
          } else {
            consume();
          }
        } else if (scenario === "task replacement") {
          const replacement = { ...task, runId: "replacement-run" };
          store.upsertTaskWithDeliveryState({ task: replacement });
          publishTaskRecordAfterAtomicStore(replacement);
        } else if (scenario === "store replacement") {
          configureTaskRegistryRuntime({ store: { ...store } });
        } else if (scenario === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
        }
      } finally {
        if (rejectPreparation) {
          release.reject(failure);
        } else {
          release.resolve();
        }
        try {
          await fence;
          await joinEvents();
        } finally {
          configureTaskRegistryRuntime({ store });
        }
      }
      const fenceError = await fence;
      if (scenario === "native commit") {
        expect(fenceError).toBeUndefined();
        expect(warning).not.toHaveBeenCalled();
      } else {
        expect(fenceError).toBeInstanceOf(Error);
        if (scenario === "native rollback" || scenario === "preparation failure") {
          expect(fenceError).toBe(failure);
        }
        const expectedMessage =
          scenario === "native rollback"
            ? "Task agent event committed before follow-up failed"
            : "Failed to persist accepted task agent event";
        expect(warning.mock.calls.filter(([message]) => message === expectedMessage)).toEqual([
          [expectedMessage, expect.objectContaining({ taskId: task.taskId, error: fenceError })],
        ]);
      }
      expect(writes).not.toHaveBeenCalled();
      const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
      expect(durable).toMatchObject({
        status: scenario === "native commit" ? "running" : "queued",
        runId: scenario === "task replacement" ? "replacement-run" : task.runId,
      });
      expect(peekSystemEvents(task.ownerKey)).toHaveLength(scenario === "native commit" ? 1 : 0);
      const read = await prepareTaskRegistryRead();
      expect(read?.isTaskSettled(task.taskId)).toBe(true);
      expect(read?.getTaskById(task.taskId)).toEqual(durable);
    });
  });
});
