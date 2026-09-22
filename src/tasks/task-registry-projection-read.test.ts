import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as taskRuntime from "./runtime-internal.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { recoverTaskAgentEventPublication } from "./task-registry-agent-event-commit.js";
import type { TaskAgentEventInput } from "./task-registry-agent-event.operation.js";
import { taskAgentEventMutations } from "./task-registry-agent-events.js";
import { updateTask } from "./task-registry-mutation.js";
import { deleteTaskRecordById } from "./task-registry-query.js";
import { prepareTaskRegistryRead, prepareTaskRegistryReadOwner } from "./task-registry-read.js";
import {
  createReadTask,
  requestTasks,
  resetReadState,
  withReadState,
} from "./task-registry-read.test-support.js";
import { captureTaskPersistenceReceipt } from "./task-registry-records.js";
import {
  prepareTaskRegistryProjectionAsync,
  runTaskRegistryWorkerMutation,
  taskDeliveryStates,
  tasks,
} from "./task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import { createTaskFixture, prepareTaskFixtureRead } from "./task-registry.test-support.js";

afterEach(resetReadState);

it.each(["unchanged", "changed", "absent", "recovered"] as const)(
  "publishes a committed task after an older refresh finishes first: %s resident row",
  async (resident) => {
    await withReadState(async () => {
      const task = createReadTask("older-refresh-newer-publication");
      const store = await prepareTaskFixtureRead(task);
      await prepareTaskRegistryRead();
      const context = captureOpenClawStateWorkerContext();
      const canonical =
        resident === "absent"
          ? undefined
          : resident !== "changed"
            ? task
            : { ...task, task: "Earlier disk value" };
      if (resident === "absent") {
        expect(deleteTaskRecordById(task.taskId)).toBe(true);
      }
      if (canonical && resident === "changed") {
        const failedPublication = vi.fn();
        const failure = new Error("Synthetic initial publication failure");
        await runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: task.taskId },
            publicationRecords: () => new Map([[task.taskId, canonical]]),
            onPublicationError: failedPublication,
          },
          async () => store.upsertTaskWithDeliveryState({ task: canonical }),
          async () => {
            throw failure;
          },
        );
        expect(failedPublication).toHaveBeenCalledExactlyOnceWith(failure);
      }
      const readOwner = await prepareTaskRegistryReadOwner();
      const scope = { taskId: task.taskId };
      let next = { ...task, task: "Later committed value" };
      const input: TaskAgentEventInput = {
        taskId: task.taskId,
        expectedTask: captureTaskPersistenceReceipt(task),
        change: { kind: "terminal", at: Date.now(), toolStarts: 0, patch: { status: "succeeded" } },
      };
      let commitFacts: unknown;
      const lostResult = new Error("Synthetic lost result after joined commit");
      const releaseWrite = createDeferred();
      const refreshCaptured = createDeferred();
      const releaseRefresh = createDeferred();
      const publicationCaptured = createDeferred();
      const releasePublication = createDeferred();
      const load = store.loadMutationSnapshotAsync.bind(store);
      let held = false;
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await load(...args);
        if (!held && Array.isArray(args[1])) {
          held = true;
          expect(snapshot.tasks.get(task.taskId)?.task).toBe(canonical?.task);
          refreshCaptured.resolve();
          await releaseRefresh.promise;
        }
        return snapshot;
      });
      const changed = vi.fn();
      const stop = onTaskRegistryChange(changed);
      let mutationFailure: unknown;
      const mutation = runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope,
          publicationRecords: () => new Map(resident === "recovered" ? [] : [[task.taskId, next]]),
          ...(resident === "recovered" && {
            recoverPublication: (snapshot: TaskRegistryStoreSnapshot) =>
              recoverTaskAgentEventPublication(commitFacts, input, snapshot.tasks.get(task.taskId))
                ?.task,
          }),
        },
        async (beginRecovery) => {
          await releaseWrite.promise;
          if (resident === "recovered") {
            beginRecovery();
            let nativeOwner: SqliteWorkerNativeSettlementOwner | undefined;
            const receipt = await store.runAgentEventMutationAsync(
              context,
              input,
              () => context.admission.assertCurrent(),
              (owner) => {
                nativeOwner = owner;
              },
            );
            if (!receipt) {
              throw new Error("Expected a committed terminal task event");
            }
            next = receipt.task;
            commitFacts = nativeOwner?.settlement?.committed?.facts;
            expect(commitFacts).toBeDefined();
            throw lostResult;
          }
          store.upsertTaskWithDeliveryState({ task: next });
        },
        async () => {
          const snapshot = await load(context, scope);
          expect(snapshot.tasks.get(task.taskId)).toMatchObject({
            task: next.task,
            status: next.status,
          });
          publicationCaptured.resolve();
          await releasePublication.promise;
          return snapshot;
        },
      ).catch((error: unknown) => {
        if (resident !== "recovered" || error !== lostResult) {
          throw error;
        }
        mutationFailure = error;
      });
      const reading = prepareTaskRegistryRead(readOwner);
      try {
        await withTestTimeout(refreshCaptured.promise, 5_000, "Older refresh captured");
        releaseWrite.resolve();
        await withTestTimeout(publicationCaptured.promise, 5_000, "Newer publication captured");
        releaseRefresh.resolve();
        const prepared = await withTestTimeout(reading, 5_000, "Older refresh finished first");
        if (prepared) {
          expect(prepared.isTaskCurrent(task.taskId)).toBe(false);
          expect(() => prepared.getTaskById(task.taskId)).toThrow("requires preparation");
        }
        releasePublication.resolve();
        await withTestTimeout(mutation, 5_000, "Newer committed mutation published");
        expect(mutationFailure).toBe(resident === "recovered" ? lostResult : undefined);
        expect(changed).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind: "upserted",
            task: expect.objectContaining({
              taskId: task.taskId,
              task: next.task,
              status: next.status,
            }),
          }),
        );
        expect(tasks.get(task.taskId)?.task).toBe(next.task);
      } finally {
        releaseWrite.resolve();
        releaseRefresh.resolve();
        releasePublication.resolve();
        await Promise.allSettled([reading, mutation]);
        stop();
      }
    });
  },
);

it.each(["newer first", "older first", "later read"] as const)(
  "retains the final canonical row across overlapping orphan refreshes: %s",
  async (completion) => {
    await withReadState(async () => {
      const task = createReadTask("overlapping-canonical-refresh");
      const store = await prepareTaskFixtureRead(task);
      await prepareTaskRegistryRead();
      const context = captureOpenClawStateWorkerContext();
      const publicationFailure = new Error("Synthetic orphaned task publication");
      const lostResult = new Error("Synthetic lost result after canonical commit");
      const failedPublication = vi.fn();
      const writeWithoutPublication = async (record: typeof task, release = Promise.resolve()) => {
        const writing = runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: task.taskId },
            publicationRecords: () => new Map(),
            onPublicationError: failedPublication,
          },
          async () => {
            await release;
            store.upsertTaskWithDeliveryState({ task: record });
            throw lostResult;
          },
          async () => {
            throw publicationFailure;
          },
        );
        await expect(writing).rejects.toBe(lostResult);
      };
      const intermediate = { ...task, task: "Intermediate canonical value" };
      const before = completion === "newer first" ? intermediate : task;
      const after = completion === "newer first" ? task : intermediate;
      await writeWithoutPublication(before);
      const load = store.loadMutationSnapshotAsync.bind(store);
      const firstCaptured = createDeferred();
      const releaseFirst = createDeferred();
      const secondCaptured = createDeferred();
      const releaseSecond = createDeferred();
      const releaseWrite = createDeferred();
      const mutation = writeWithoutPublication(after, releaseWrite.promise);
      let reads = 0;
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await load(...args);
        if (Array.isArray(args[1])) {
          reads += 1;
          if (reads === 1) {
            expect(snapshot.tasks.get(task.taskId)?.task).toBe(before.task);
            firstCaptured.resolve();
            await releaseFirst.promise;
          } else if (reads === 2) {
            expect(snapshot.tasks.get(task.taskId)?.task).toBe(after.task);
            secondCaptured.resolve();
            await releaseSecond.promise;
          }
        }
        return snapshot;
      });
      const first = prepareTaskRegistryProjectionAsync(context, store, 1);
      let second: ReturnType<typeof requestTasks> | undefined;
      try {
        await withTestTimeout(firstCaptured.promise, 5_000, "First canonical refresh captured");
        releaseWrite.resolve();
        await mutation;
        expect(failedPublication).toHaveBeenCalledTimes(2);
        if (completion !== "later read") {
          second = requestTasks(task.ownerKey);
          await withTestTimeout(secondCaptured.promise, 5_000, "Later canonical refresh captured");
        }
        if (completion !== "newer first") {
          releaseFirst.resolve();
          expect(await withTestTimeout(first, 5_000, "Older refresh refused the orphan")).toBe(
            false,
          );
        }
        releaseSecond.resolve();
        second ??= requestTasks(task.ownerKey);
        const laterResponse = await withTestTimeout(
          second,
          5_000,
          "Later canonical refresh finished",
        );
        expect(laterResponse.mock.calls[0]).toMatchObject([
          true,
          { tasks: [{ id: task.taskId, title: after.task }] },
        ]);
        releaseFirst.resolve();
        const prepared = await withTestTimeout(first, 5_000, "Older refresh settled");
        if (completion === "newer first") {
          expect(prepared).toBe(true);
        }
        expect(tasks.get(task.taskId)?.task).toBe(after.task);
      } finally {
        releaseWrite.resolve();
        releaseFirst.resolve();
        releaseSecond.resolve();
        await Promise.allSettled([first, second, mutation]);
      }
    });
  },
);

it.each(["newer value", "ABA during metadata"] as const)(
  "keeps canonical data from an orphaned write after an older readback settles: %s",
  async (change) => {
    await withReadState(async () => {
      const task = createReadTask("refresh-after-orphaned-write");
      const unrelated = createTaskFixture("cli", {
        runId: "unrelated-refresh-metadata",
        requesterSessionKey: "agent:main:other-refresh",
        ownerKey: "agent:main:other-refresh",
        task: "Unrelated metadata",
        notifyPolicy: "silent",
        lastEventAt: 100,
      });
      const store = await prepareTaskFixtureRead(task);
      await prepareTaskRegistryRead();
      const context = captureOpenClawStateWorkerContext();
      const scope = { taskId: task.taskId };
      const older = { ...task, task: "Older committed value" };
      const newer = { ...task, task: "Newer committed value", status: "succeeded" as const };
      const canonical = change === "newer value" ? newer : older;
      const olderRead = createDeferred();
      const releaseOlder = createDeferred();
      const newerCommitted = createDeferred();
      const failure = new Error("Synthetic newer publication readback failure");
      const failedPublication = vi.fn();
      const mutations: Promise<unknown>[] = [];
      const load = store.loadMutationSnapshotAsync.bind(store);
      const capture = taskAgentEventMutations.captureReadFence.bind(taskAgentEventMutations);
      vi.spyOn(taskAgentEventMutations, "captureReadFence").mockImplementationOnce((admission) =>
        capture(admission).then(async () => {
          mutations.push(
            runTaskRegistryWorkerMutation(
              {
                admission: context.admission,
                scope,
                publicationRecords: () => new Map([[task.taskId, older]]),
              },
              async () => store.upsertTaskWithDeliveryState({ task: older }),
              async () => {
                const snapshot = await load(context, scope);
                olderRead.resolve();
                await releaseOlder.promise;
                return snapshot;
              },
            ),
          );
          await withTestTimeout(olderRead.promise, 5_000, "Older canonical read captured");
          mutations.push(
            runTaskRegistryWorkerMutation(
              {
                admission: context.admission,
                scope: { taskId: task.taskId },
                publicationRecords: () => new Map([[task.taskId, canonical]]),
                onPublicationError: failedPublication,
              },
              async () => {
                store.upsertTaskWithDeliveryState({
                  task: change === "newer value" ? newer : { ...older, task: "Intermediate value" },
                });
                if (change === "ABA during metadata") {
                  store.upsertTaskWithDeliveryState({ task: older });
                }
                newerCommitted.resolve();
              },
              async () => {
                throw failure;
              },
            ),
          );
          await withTestTimeout(newerCommitted.promise, 5_000, "Newer canonical write committed");
        }),
      );
      let held = false;
      let metadataWrites = 0;
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await load(...args);
        if (!held && Array.isArray(args[1])) {
          held = true;
          expect(snapshot.tasks.get(task.taskId)).toMatchObject({
            task: canonical.task,
            status: canonical.status,
          });
          releaseOlder.resolve();
          await Promise.all(mutations);
          expect(failedPublication).toHaveBeenCalledExactlyOnceWith(failure);
          expect(tasks.get(task.taskId)).toMatchObject({
            task: change === "newer value" ? task.task : older.task,
            status: "running",
          });
        }
        if (Array.isArray(args[1]) && change === "ABA during metadata" && metadataWrites < 32) {
          metadataWrites += 1;
          expect(
            updateTask(unrelated.taskId, { lastEventAt: 100 + metadataWrites }),
          ).not.toBeNull();
        }
        return snapshot;
      });
      const reading = requestTasks(task.ownerKey);
      try {
        const response = await withTestTimeout(reading, 5_000, "Orphaned canonical row reconciled");
        expect(held).toBe(true);
        expect(response.mock.calls[0]).toMatchObject([
          true,
          {
            tasks: [
              {
                id: task.taskId,
                title: canonical.task,
                status: canonical.status === "succeeded" ? "completed" : "running",
              },
            ],
          },
        ]);
        expect(tasks.get(task.taskId)).toMatchObject({
          task: canonical.task,
          status: canonical.status,
        });
      } finally {
        releaseOlder.resolve();
        await Promise.allSettled([reading, ...mutations]);
      }
    });
  },
);

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
