import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import {
  createReadTask,
  requestTasks,
  resetReadState,
  withReadState,
} from "./task-registry-read.test-support.js";
import { runTaskRegistryWorkerMutation, taskDeliveryStates, tasks } from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import { prepareTaskFixtureRead } from "./task-registry.test-support.js";

afterEach(resetReadState);

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
      const execute = vi.spyOn(workerStore, "executeOpenClawStateWorker");
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
          expect(
            execute.mock.calls.filter(([, command]) => command.type === "tasks.mutationSnapshot"),
          ).toHaveLength(1);
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
