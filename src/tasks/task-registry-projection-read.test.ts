import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as taskRuntime from "./runtime-internal.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { taskAgentEventMutations } from "./task-registry-agent-events.js";
import * as listenerState from "./task-registry-listener-state.js";
import { updateTask } from "./task-registry-mutation.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import {
  createReadTask,
  requestTasks,
  resetReadState,
  withReadState,
} from "./task-registry-read.test-support.js";
import { runTaskRegistryWorkerMutation, taskDeliveryStates, tasks } from "./task-registry-state.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import { createTaskFixture, prepareTaskFixtureRead } from "./task-registry.test-support.js";

afterEach(resetReadState);

it.each(["unchanged", "status and order", "delivery", "read failure"] as const)(
  "retains a prepared task page only while worker publication is unchanged: %s",
  async (change) => {
    await withReadState(async () => {
      const task = createTaskFixture("cli", {
        runId: "page-publication-first",
        task: "First task",
        startedAt: 100,
        lastEventAt: 100,
        notifyPolicy: "silent",
      });
      const second = createTaskFixture("cli", {
        runId: "page-publication-second",
        task: "Second task",
        startedAt: 200,
        lastEventAt: 200,
        notifyPolicy: "silent",
      });
      const store = await prepareTaskFixtureRead(task);
      const context = captureOpenClawStateWorkerContext();
      const page = await taskRuntime.listTaskRecordPage({ offset: 0, limit: 1 });
      expect(page.ok).toBe(true);
      if (!page.ok) {
        throw new Error("Expected the initial task page");
      }
      expect(page.value.tasks.map((record) => record.taskId)).toEqual([second.taskId]);
      const entered = createDeferred();
      const release = createDeferred();
      const reading = createDeferred();
      const releaseRead = createDeferred();
      const publicationError = vi.fn();
      const failure = new Error("Synthetic page publication readback failure");
      const changesOrder = change === "status and order" || change === "read failure";
      const next = changesOrder
        ? { ...task, status: "succeeded" as const, endedAt: 300, lastEventAt: 300 }
        : task;
      const mutation = runTaskRegistryWorkerMutation(
        {
          scope: { taskId: task.taskId },
          admission: context.admission,
          readIdentity: "preserved",
          publicationRecords: () => new Map([[task.taskId, next]]),
          onPublicationError: publicationError,
        },
        async () => {
          entered.resolve();
          await release.promise;
          store.upsertTaskWithDeliveryState({
            task: next,
            ...(change === "delivery"
              ? { deliveryState: { taskId: task.taskId, lastNotifiedEventAt: 300 } }
              : {}),
          });
        },
        async () => {
          reading.resolve();
          await releaseRead.promise;
          if (change === "read failure") {
            throw failure;
          }
          return store.loadMutationSnapshotAsync(context, { taskId: task.taskId });
        },
      );
      const settled = Promise.allSettled([mutation]);
      try {
        await withTestTimeout(entered.promise, 5_000, "Preserved mutation reached admission");
        expect(page.value.isCurrent()).toBe(true);
        release.resolve();
        await withTestTimeout(reading.promise, 5_000, "Preserved mutation reached readback");
        expect(page.value.isCurrent()).toBe(true);
        releaseRead.resolve();
        await mutation;
        expect(publicationError).toHaveBeenCalledTimes(change === "read failure" ? 1 : 0);
        if (change === "read failure") {
          expect(publicationError).toHaveBeenCalledWith(failure);
        }
        expect(page.value.isCurrent()).toBe(change === "unchanged");
        const continuation = await taskRuntime.listTaskRecordPage({
          offset: 1,
          limit: 1,
          expectedRevision: page.value.revision,
        });
        if (change === "unchanged") {
          expect(continuation).toMatchObject({
            ok: true,
            value: { tasks: [{ taskId: task.taskId }] },
          });
        } else {
          expect(continuation).toEqual({ ok: false, error: "cursor_stale" });
        }
        const fresh = await taskRuntime.listTaskRecordPage({ offset: 0, limit: 2 });
        expect(fresh).toMatchObject({
          ok: true,
          value: {
            tasks: changesOrder
              ? [{ taskId: task.taskId, status: "succeeded" }, { taskId: second.taskId }]
              : [{ taskId: second.taskId }, { taskId: task.taskId, status: "running" }],
          },
        });
        if (change === "delivery") {
          expect(taskDeliveryStates.get(task.taskId)?.lastNotifiedEventAt).toBe(300);
        }
      } finally {
        release.resolve();
        releaseRead.resolve();
        await settled;
      }
    });
  },
);

it.each(["current", "read failure", "retired store"] as const)(
  "prepares registered task reads from one overlapping scope snapshot: %s",
  async (outcome) => {
    await withReadState(async () => {
      const first = createReadTask("union-first");
      const second = createReadTask("union-second");
      const overlap = createReadTask("union-overlap");
      const removed = createReadTask("union-removed");
      const unrelated = createReadTask("union-unrelated");
      const store = await prepareTaskFixtureRead(first);
      const context = captureOpenClawStateWorkerContext();
      const load = store.loadMutationSnapshotAsync.bind(store);
      const releaseMutations = createDeferred();
      const releaseRead = createDeferred();
      const enteredRead = createDeferred();
      const failure = new Error("Synthetic union snapshot failure");
      const snapshots: TaskRegistryStoreSnapshot[] = [];
      const scopes: TaskRegistryMutationScope[] = [
        { taskId: first.taskId, runId: second.runId },
        { taskId: second.taskId, runId: first.runId },
        { taskId: overlap.taskId },
        { taskId: removed.taskId },
      ];
      const nextFirst = { ...first, task: "Fresh first" };
      const nextSecond = { ...second, task: "Fresh second" };
      const nextOverlap = {
        ...overlap,
        task: "Fresh overlapping task",
      };
      const firstDelivery = { taskId: first.taskId, lastNotifiedEventAt: 17 };
      const overlapDelivery = { taskId: overlap.taskId, lastNotifiedEventAt: 23 };
      const mutations = scopes.map((scope, index) =>
        runTaskRegistryWorkerMutation(
          {
            scope,
            admission: context.admission,
            readIdentity: "preserved",
            publicationRecords: () => new Map(),
          },
          async () => {
            if (index === 0) {
              store.upsertTaskWithDeliveryState({ task: nextFirst, deliveryState: firstDelivery });
            } else if (index === 1) {
              store.upsertTaskWithDeliveryState({ task: nextSecond });
            } else if (index === 2) {
              store.upsertTaskWithDeliveryState({
                task: nextOverlap,
                deliveryState: overlapDelivery,
              });
            } else {
              store.deleteTaskWithDeliveryState(removed.taskId);
            }
            await releaseMutations.promise;
          },
          () => load(context, scope),
        ),
      );
      const previousTasks = new Map(tasks);
      const previousDelivery = new Map(taskDeliveryStates);
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await load(...args);
        snapshots.push(snapshot);
        enteredRead.resolve();
        await releaseRead.promise;
        if (outcome === "read failure") {
          throw failure;
        }
        return snapshot;
      });
      const respond = vi.fn();
      const reading = requestTasks(first.ownerKey, respond);
      const settled = Promise.allSettled([reading]);
      try {
        await withTestTimeout(enteredRead.promise, 5_000, "Task read reached its worker snapshot");
        expect(respond).not.toHaveBeenCalled();
        expect(tasks).toEqual(previousTasks);
        expect(taskDeliveryStates).toEqual(previousDelivery);
        if (outcome === "retired store") {
          configureTaskRegistryRuntime({ store: { ...store } });
        }
        releaseRead.resolve();
        const [result] = await withTestTimeout(settled, 5_000, "Task read settled its snapshot");
        if (outcome === "current") {
          expect(result.status).toBe("fulfilled");
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[1]).toHaveProperty("tasks.length", 4);
          expect(respond.mock.calls[0]).toMatchObject([
            true,
            {
              tasks: expect.arrayContaining(
                [
                  { id: first.taskId, title: nextFirst.task },
                  { id: second.taskId, title: nextSecond.task },
                  { id: overlap.taskId, title: nextOverlap.task },
                  { id: unrelated.taskId, title: unrelated.task },
                ].map((task) => expect.objectContaining(task)),
              ),
            },
          ]);
          expect(tasks).toEqual(
            new Map([
              [first.taskId, nextFirst],
              [second.taskId, nextSecond],
              [overlap.taskId, nextOverlap],
              [unrelated.taskId, unrelated],
            ]),
          );
          expect(taskDeliveryStates).toEqual(
            new Map([
              [first.taskId, firstDelivery],
              [overlap.taskId, overlapDelivery],
            ]),
          );
          expect(snapshots).toEqual([
            {
              tasks: new Map([
                [first.taskId, nextFirst],
                [second.taskId, nextSecond],
                [overlap.taskId, nextOverlap],
              ]),
              deliveryStates: new Map([
                [first.taskId, firstDelivery],
                [overlap.taskId, overlapDelivery],
              ]),
            },
          ]);
        } else {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") {
            if (outcome === "read failure") {
              expect(result.reason).toBe(failure);
            } else {
              expect(result.reason.message).toContain("owner");
            }
          }
          expect(respond).not.toHaveBeenCalled();
          expect(tasks).toEqual(previousTasks);
          expect(taskDeliveryStates).toEqual(previousDelivery);
        }
      } finally {
        releaseRead.resolve();
        await settled;
        releaseMutations.resolve();
        await Promise.allSettled(mutations);
      }
    });
  },
);

describe("registered task list read fence", () => {
  it.each(["another run", "same run", "new committed target"] as const)(
    "keeps creation identity checks scoped while holding %s",
    async (change) => {
      await withReadState(async () => {
        const historical = createTaskFixture("cli", {
          runId: "historical-session-run",
          childSessionKey: "agent:main:repeated-session",
          ownerKey: "agent:main:repeated-session",
          requesterSessionKey: "agent:main:repeated-session",
          task: "Session turn",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const store = await prepareTaskFixtureRead(historical);
        const prepared = await prepareTaskRegistryRead();
        expect(prepared).toBeDefined();
        const captured = createDeferred();
        const releaseRead = createDeferred();
        const entered = createDeferred();
        const releaseCreation = createDeferred();
        const capture = listenerState.captureTaskRegistryReadFence;
        vi.spyOn(listenerState, "captureTaskRegistryReadFence").mockImplementationOnce(
          (admission) => {
            const fence = capture(admission);
            captured.resolve();
            return fence.then(() => releaseRead.promise);
          },
        );
        const mutate = store.runInitialMutationAsync.bind(store);
        vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
          if (args[1].type !== "tasks.createRecord") {
            return mutate(...args);
          }
          if (change === "new committed target") {
            const result = await mutate(...args);
            entered.resolve();
            await releaseCreation.promise;
            return result;
          }
          entered.resolve();
          await releaseCreation.promise;
          return mutate(...args);
        });
        const reading = requestTasks(historical.ownerKey);
        let creation: ReturnType<typeof createRunningTaskRunCoreWithReceiptAsync> | undefined;
        try {
          await captured.promise;
          creation = createRunningTaskRunCoreWithReceiptAsync({
            runtime: "cli",
            runId: change === "same run" ? historical.runId! : "next-session-run",
            childSessionKey: historical.childSessionKey,
            ownerKey: historical.ownerKey,
            scopeKind: historical.scopeKind,
            requesterSessionKey: historical.requesterSessionKey,
            task: historical.task,
            detail: { generation: "next" },
            notifyPolicy: "silent",
            deliveryStatus: "not_applicable",
          });
          await entered.promise;
          // Discovering a session backing or waiting for all writes still needs the broad scope.
          expect(prepared?.isChildSessionCurrent(historical.childSessionKey!)).toBe(false);
          expect(prepared?.isTaskSettled(historical.taskId)).toBe(false);
          releaseRead.resolve();
          const respond = await reading;
          if (change === "another run") {
            expect(respond.mock.calls).toMatchObject([
              [true, { tasks: [{ id: historical.taskId }] }],
            ]);
          } else {
            expect(respond.mock.calls).toMatchObject([[false, undefined, { code: "UNAVAILABLE" }]]);
          }
        } finally {
          releaseRead.resolve();
          releaseCreation.resolve();
          await Promise.allSettled([reading, creation]);
        }
      });
    },
  );

  it("retries a changed page without joining events accepted after its first read", async () => {
    await withReadState(async () => {
      const task = createReadTask("read-before-page-retry");
      const later = createTaskFixture("cli", {
        runId: "accepted-after-page-selection",
        ownerKey: "agent:main:later-event",
        requesterSessionKey: "agent:main:later-event",
        task: "Unrelated later work",
        status: "running",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
        if (args[1].taskId === later.taskId) {
          entered.resolve();
          await release.promise;
        }
        return mutate(...args);
      });
      const select = taskRuntime.listTaskRecordPage;
      let changed = false;
      vi.spyOn(taskRuntime, "listTaskRecordPage").mockImplementation(async (params) => {
        const page = await select(params);
        if (!changed && page.ok) {
          changed = true;
          expect(page.value.tasks).toMatchObject([{ taskId: task.taskId, toolUseCount: 1 }]);
          expect(updateTask(task.taskId, { task: "Changed before response" })).not.toBeNull();
          emitAgentEvent({
            runId: later.runId!,
            stream: "tool",
            data: { phase: "start", name: "later-tool" },
          });
          await withTestTimeout(entered.promise, 5_000, "Later event did not reach its barrier");
        }
        return page;
      });
      emitAgentEvent({
        runId: task.runId!,
        stream: "tool",
        data: { phase: "start", name: "accepted-before-read" },
      });
      const read = requestTasks(task.ownerKey);
      try {
        await withTestTimeout(
          Promise.race([
            entered.promise,
            read.then(() => {
              throw new Error("Task request settled before the later-event barrier");
            }),
          ]),
          5_000,
          "Later event did not reach its barrier",
        );
        const response = await withTestTimeout(read, 5_000, "Page retry joined a later event");
        expect(changed).toBe(true);
        expect(response.mock.calls[0]).toMatchObject([
          true,
          { tasks: [{ id: task.taskId, title: "Changed before response", toolUseCount: 1 }] },
        ]);
      } finally {
        release.resolve();
        await read;
        await prepareTaskRegistryRead();
      }
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(later.taskId)).toMatchObject({
        toolUseCount: 1,
        lastToolName: "later-tool",
      });
    });
  });
});

it("settles admitted run creations before preparing a registered task page", async () => {
  await withReadState(async () => {
    const originals = Array.from({ length: 4 }, (_, index) =>
      createReadTask(`admitted-creation-${index}`),
    );
    const first = originals[0]!;
    const store = await prepareTaskFixtureRead(first);
    await requestTasks(first.ownerKey);
    const context = captureOpenClawStateWorkerContext();
    const mutate = store.runInitialMutationAsync.bind(store);
    const load = store.loadMutationSnapshotAsync.bind(store);
    const committed = createDeferred();
    const release = createDeferred();
    let committedCount = 0;
    vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[1].type === "tasks.createRecord") {
        committedCount += 1;
        if (committedCount === originals.length) {
          committed.resolve();
        }
        await release.promise;
      }
      return result;
    });
    const creations = originals.map((task) =>
      createRunningTaskRunCoreWithReceiptAsync({
        runtime: task.runtime,
        runId: task.runId!,
        task: task.task,
        ownerKey: task.ownerKey,
        scopeKind: task.scopeKind,
        requesterSessionKey: task.requesterSessionKey,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        detail: { historyGeneration: "replacement" },
      }),
    );
    const settled = Promise.allSettled(creations);
    let reading: ReturnType<typeof requestTasks> | undefined;
    try {
      await withTestTimeout(committed.promise, 5_000, "Run creations committed before publication");
      const snapshot = await load(
        context,
        originals.map((task) => ({ taskId: task.taskId, runId: task.runId })),
      );
      // Read-only snapshots may finish before the creation owners publish their committed rows.
      // Keep those canonical rows fixed while producer readbacks retain their real worker path.
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) =>
        Array.isArray(args[1]) ? snapshot : load(...args),
      );
      const entered = createDeferred();
      const fence = taskAgentEventMutations.captureReadFence.bind(taskAgentEventMutations);
      vi.spyOn(taskAgentEventMutations, "captureReadFence").mockImplementationOnce((admission) => {
        const result = fence(admission);
        entered.resolve();
        return result;
      });
      const respond = vi.fn();
      reading = requestTasks(first.ownerKey, respond);
      await withTestTimeout(entered.promise, 5_000, "Registered read captured its admitted work");
      release.resolve();
      await withTestTimeout(reading, 5_000, "Registered read joined run creation publication");
      await Promise.all(creations);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]).toMatchObject([
        true,
        {
          tasks: expect.arrayContaining(
            originals.map((task) => expect.objectContaining({ id: task.taskId })),
          ),
        },
      ]);
    } finally {
      release.resolve();
      await settled;
      await reading?.catch(() => {});
    }
  });
});
