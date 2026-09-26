import { setImmediate } from "node:timers/promises";
import { deserialize } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as workerAdmission from "../infra/sqlite-worker-broker-admission.js";
import type { Job } from "../infra/sqlite-worker-broker.types.js";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { CRON_HISTORY_KEEP_PER_JOB } from "./cron-history-retention.js";
import { loadTaskAcpSessionCloser } from "./task-registry-acp-cleanup.js";
import { getTaskPreparedActivity, recordTaskActivityEvent } from "./task-registry-activity.js";
import * as snapshots from "./task-registry-maintenance-snapshot.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { isTaskRegistryTaskSettled, prepareTaskRegistryRead } from "./task-registry-read.js";
import {
  getTasksByRunId,
  taskActivityByTaskId,
  taskDeliveryStates,
  taskIdsByOwnerKey,
  taskIdsByRelatedSessionKey,
  tasks,
} from "./task-registry-state.js";
import { runTaskRegistryMaintenance } from "./task-registry.maintenance.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
  onTaskRegistryChange,
} from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.types.js";
import {
  createStoredTask,
  createTaskFixture,
  prepareTaskFixtureRead,
  reloadTaskRegistryFromStoreAsync,
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resetTaskFlowRegistryForTests } from "./task-runtime.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function taskMembership(task: TaskRecord) {
  return {
    owner: taskIdsByOwnerKey.get(task.ownerKey)?.has(task.taskId) ?? false,
    requester: taskIdsByRelatedSessionKey.get(task.requesterSessionKey)?.has(task.taskId) ?? false,
    child: taskIdsByRelatedSessionKey.get(task.childSessionKey ?? "")?.has(task.taskId) ?? false,
    ...(task.runId
      ? { run: getTasksByRunId(task.runId).some((current) => current.taskId === task.taskId) }
      : {}),
  };
}

describe("task maintenance retention", () => {
  it("preserves cron overflow rows whose partition or rank changed after the maintenance snapshot", async () => {
    await withTaskRegistryTempDir(async () => {
      await runTaskRegistryMaintenance();
      const now = Date.now();
      const storeKey = "original raw store ";
      const records: TaskRecord[] = Array.from(
        { length: CRON_HISTORY_KEEP_PER_JOB + 5 },
        (_, index) => ({
          ...createStoredTask(),
          taskId: `cron-overflow-${index}`,
          runtime: "cron",
          sourceId: "retention-job ",
          status: "succeeded",
          createdAt: now + index,
          endedAt: now + index,
          lastEventAt: now + index,
          cleanupAfter: now + 86_400_000,
          notifyPolicy: "silent",
          detail: { kind: "cron-run", storeKey },
        }),
      );
      const changes: Partial<TaskRecord>[] = [
        { detail: { kind: "cron-run", storeKey: " original raw store " } },
        { sourceId: "retention-job" },
        { detail: { kind: "quiet", storeKey } },
        { endedAt: now + 60_000, lastEventAt: now + 60_000 },
      ];
      const replacements = changes.map((change, index) => ({
        ...expectDefined(records[index], "selected cron overflow row"),
        ...change,
      }));
      const control = expectDefined(records[changes.length], "unchanged cron overflow row");
      const store = createInMemoryTaskRegistryStore({
        tasks: new Map(records.map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      });
      configureTaskRegistryRuntime({ store });
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      const snapshot = snapshots.getTaskRegistryMaintenanceSnapshot;
      vi.spyOn(snapshots, "getTaskRegistryMaintenanceSnapshot").mockImplementationOnce((read) => {
        const selected = snapshot(read);
        for (const replacement of replacements) {
          store.upsertTaskWithDeliveryState({ task: replacement });
          publishTaskRecordAfterAtomicStore(replacement);
        }
        return selected;
      });

      const summary = await runTaskRegistryMaintenance();

      expect(summary.pruned).toBe(1);
      expect(tasks.has(control.taskId)).toBe(false);
      const stored = store.loadSnapshot().tasks;
      expect(stored.has(control.taskId)).toBe(false);
      for (const replacement of replacements) {
        expect(tasks.get(replacement.taskId)).toEqual(replacement);
        expect(stored.get(replacement.taskId)).toEqual(replacement);
      }
    });
  });

  it.each(["prune", "stamp"] as const)(
    "keeps %s responsive and unpublished while foreign writer custody is held",
    async (operation) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-task-retention-" },
        async () => {
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
          try {
            const now = Date.now();
            const store = getTaskRegistryStore();
            const fixtures = [true, false].map((withRunId) => {
              const task = createTaskFixture("cli", {
                task: `Completed work ${withRunId ? "with" : "without"} a run ID`,
                runId: withRunId ? `retention-${operation}` : undefined,
                requesterSessionKey: "agent:main:retention-requester",
                childSessionKey: "agent:main:retention-child",
                status: "succeeded",
                startedAt: now - 120_000,
                lastEventAt: now - 60_000,
                cleanupAfter: operation === "prune" ? now - 1 : undefined,
                notifyPolicy: "silent",
                requesterOrigin: { channel: "discord", to: "channel:synthetic-retention" },
              });
              const delivery = expectDefined(
                taskDeliveryStates.get(task.taskId),
                "persisted requester delivery state",
              );
              if (operation === "stamp") {
                // Creation supplies retention; seed an older ledger row missing that field.
                const unstamped = { ...task };
                delete unstamped.cleanupAfter;
                store.upsertTaskWithDeliveryState({ task: unstamped, deliveryState: delivery });
              }
              return task;
            });
            const context = captureOpenClawStateWorkerContext();
            await reloadTaskRegistryFromStoreAsync(context);
            await loadTaskAcpSessionCloser();
            await prepareTaskRegistryRead();
            for (const task of fixtures) {
              await prepareTaskFixtureRead(task);
            }

            const before = fixtures.map(({ taskId }) => {
              const task = structuredClone(expectDefined(tasks.get(taskId), "resident task"));
              recordTaskActivityEvent(task, {
                runId: task.runId ?? "unbound-retention-activity",
                seq: 1,
                ts: now,
                stream: "item",
                data: {
                  itemId: "retained-activity",
                  kind: "tool",
                  phase: "end",
                  title: "Completed synthetic work",
                  status: "completed",
                },
              });
              const activity = structuredClone(
                expectDefined(getTaskPreparedActivity(taskId), "prepared task activity"),
              );
              expect(activity.size).toBe(1);
              expect(taskMembership(task)).toEqual({
                owner: true,
                requester: true,
                child: true,
                ...(task.runId ? { run: true } : {}),
              });
              expect(task.cleanupAfter).toBe(operation === "prune" ? now - 1 : undefined);
              return {
                task,
                activity,
                delivery: structuredClone(taskDeliveryStates.get(taskId)),
                membership: taskMembership(task),
              };
            });
            const published: TaskRegistryObserverEvent[] = [];
            const stop = onTaskRegistryChange((event) => {
              if (event && event.kind !== "restored") {
                published.push(event);
              }
            });
            const contended = createDeferred();
            const taskIds = new Set(fixtures.map(({ taskId }) => taskId));
            const checks = new WeakMap<Job, number>();
            const borrowLifecycle = workerAdmission.borrowSqliteWorkerLifecycle;
            const observedContention = vi
              .spyOn(workerAdmission, "borrowSqliteWorkerLifecycle")
              .mockImplementation((job, actor) => {
                const delegate = borrowLifecycle(job, actor);
                if (
                  !delegate &&
                  job.lifecyclePreparation &&
                  job.request.type === "execute" &&
                  (job.request.stateDatabasePath ?? actor.databasePath) ===
                    context.admission.databasePath
                ) {
                  const command: unknown = deserialize(job.request.input);
                  if (
                    isRecord(command) &&
                    command.type === "tasks.applyRetention" &&
                    isRecord(command.input) &&
                    typeof command.input.taskId === "string" &&
                    taskIds.has(command.input.taskId)
                  ) {
                    const count = (checks.get(job) ?? 0) + 1;
                    checks.set(job, count);
                    // A second worker check follows a failed native coordinator acquisition.
                    if (count === 2) {
                      contended.resolve();
                    }
                  }
                }
                return delegate;
              });
            // This escape hatch releases a regressed synchronous native waiter, not normal proof.
            const holder = holdStateDatabaseCoordinator(
              context.admission.databasePath,
              context.coordinatorRuntime,
              1_000,
            );
            let maintenance: ReturnType<typeof runTaskRegistryMaintenance> | undefined;
            let summary: Awaited<ReturnType<typeof runTaskRegistryMaintenance>> | undefined;
            const failures: unknown[] = [];
            const recordFailure = (error: unknown) => {
              if (!failures.includes(error)) {
                failures.push(error);
              }
            };
            try {
              await holder.ready;
              maintenance = runTaskRegistryMaintenance();
              await Promise.race([
                contended.promise,
                maintenance.then(() => {
                  throw new Error("Maintenance completed without a contended retention write");
                }),
                holder.joined.then(() => {
                  throw new Error("Coordinator custody escaped before retention contention");
                }),
              ]);
              // A single deferred native wait must not satisfy the responsiveness witness.
              await setImmediate();
              await setImmediate();
              expect(Atomics.load(holder.released, 0)).toBe(0);
              expect(published).toEqual([]);
              for (const { task, delivery, membership, activity } of before) {
                expect(tasks.get(task.taskId)).toEqual(task);
                expect(taskDeliveryStates.get(task.taskId)).toEqual(delivery);
                expect(taskMembership(task)).toEqual(membership);
                expect(taskActivityByTaskId.has(task.taskId)).toBe(true);
                expect(getTaskPreparedActivity(task.taskId)).toEqual(activity);
              }
            } catch (error) {
              recordFailure(error);
            } finally {
              holder.release();
              const settled = await Promise.allSettled([maintenance, holder.joined]);
              for (const result of settled) {
                if (result.status === "rejected") {
                  recordFailure(result.reason);
                }
              }
              if (settled[0].status === "fulfilled") {
                summary = settled[0].value;
              }
              observedContention.mockRestore();
              stop();
            }
            if (failures.length > 0) {
              throw new AggregateError(failures, "Retention proof or worker cleanup failed");
            }

            expect(summary).toEqual({
              reconciled: 0,
              recovered: 0,
              cleanupStamped: operation === "stamp" ? before.length : 0,
              pruned: operation === "prune" ? before.length : 0,
            });
            const durable = loadTaskRegistryStateFromSqliteReadOnly();
            expect(published).toHaveLength(before.length);
            for (const { task, delivery, membership, activity } of before) {
              if (operation === "prune") {
                expect(tasks.has(task.taskId)).toBe(false);
                expect(durable.tasks.has(task.taskId)).toBe(false);
                expect(taskDeliveryStates.has(task.taskId)).toBe(false);
                expect(durable.deliveryStates.has(task.taskId)).toBe(false);
                expect(taskMembership(task)).toEqual({
                  owner: false,
                  requester: false,
                  child: false,
                  ...(task.runId ? { run: false } : {}),
                });
                expect(taskActivityByTaskId.has(task.taskId)).toBe(false);
                expect(getTaskPreparedActivity(task.taskId)).toBeUndefined();
                expect(published).toContainEqual(
                  expect.objectContaining({ kind: "deleted", taskId: task.taskId }),
                );
              } else {
                const retained = { ...task, cleanupAfter: now - 60_000 + 7 * 24 * 60 * 60_000 };
                expect(tasks.get(task.taskId)).toEqual(retained);
                expect(durable.tasks.get(task.taskId)).toEqual(retained);
                expect(taskDeliveryStates.get(task.taskId)).toEqual(delivery);
                expect(durable.deliveryStates.get(task.taskId)).toEqual(delivery);
                expect(taskMembership(task)).toEqual(membership);
                expect(getTaskPreparedActivity(task.taskId)).toEqual(activity);
                expect(published).toContainEqual(
                  expect.objectContaining({ kind: "upserted", task: retained }),
                );
              }
            }
          } finally {
            await closeOpenClawStateDatabaseAsync();
            resetTaskRegistryForTests({ persist: false });
            resetTaskFlowRegistryForTests({ persist: false });
            await drainGlobalSingletonLifecycleState("close");
          }
        },
      );
    },
  );

  it.each([
    "result delivery fails",
    "result delivery fails after metadata changes",
    "result delivery fails without a native receipt",
    "authority is revoked before commit",
    "metadata changes after source preparation",
  ] as const)("publishes only committed pruning when %s", async (failure) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-retention-settlement-" },
      async () => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        try {
          const now = Date.now();
          const task = createTaskFixture("cli", {
            task: "Prune only the committed terminal record",
            runId: "retention-settlement",
            requesterSessionKey: "agent:main:retention-requester",
            childSessionKey: "agent:main:retention-child",
            status: "succeeded",
            startedAt: now - 120_000,
            lastEventAt: now - 60_000,
            cleanupAfter: now - 1,
            notifyPolicy: "silent",
            requesterOrigin: { channel: "discord", to: "channel:synthetic-retention" },
          });
          await loadTaskAcpSessionCloser();
          await prepareTaskRegistryRead();
          recordTaskActivityEvent(task, {
            runId: "retention-settlement",
            seq: 1,
            ts: now,
            stream: "item",
            data: {
              itemId: "retained-activity",
              kind: "tool",
              phase: "end",
              title: "Completed synthetic work",
              status: "completed",
            },
          });
          const before = {
            task: structuredClone(expectDefined(tasks.get(task.taskId), "resident task")),
            delivery: structuredClone(
              expectDefined(taskDeliveryStates.get(task.taskId), "requester delivery state"),
            ),
            membership: taskMembership(task),
            activity: structuredClone(
              expectDefined(getTaskPreparedActivity(task.taskId), "prepared task activity"),
            ),
          };
          expect(before.activity.size).toBe(1);
          const store = getTaskRegistryStore();
          const metadataChanges = failure === "result delivery fails after metadata changes";
          const sourceChangedAfterPreparation =
            failure === "metadata changes after source preparation";
          const receiptUnavailable = failure === "result delivery fails without a native receipt";
          const resultDeliveryFails =
            failure === "result delivery fails" || metadataChanges || receiptUnavailable;
          const prepare = store.prepareRetentionSourceAsync.bind(store);
          let reused: TaskRecord | undefined;
          const preparation = metadataChanges
            ? vi.spyOn(store, "prepareRetentionSourceAsync").mockImplementation(async (...args) => {
                if (!reused && args[1] === task.taskId) {
                  reused = createTaskFixture(task.runtime, {
                    ...task,
                    sourceId: "source-filled-before-retention",
                  });
                }
                return await prepare(...args);
              })
            : undefined;
          const mutate = store.runInitialMutationAsync.bind(store);
          let nativeOwner: SqliteWorkerNativeSettlementOwner | undefined;
          let deliveredOwner: SqliteWorkerNativeSettlementOwner | undefined;
          let grants = 0;
          let revoked = false;
          const readbacks = vi.spyOn(store, "loadMutationSnapshotAsync");
          let readbacksAtResultDelivery = 0;
          const writes = vi
            .spyOn(store, "runInitialMutationAsync")
            .mockImplementation(async (context, command, assertCurrent, onGranted) => {
              if (command.type !== "tasks.applyRetention") {
                return await mutate(context, command, assertCurrent, onGranted);
              }
              if (sourceChangedAfterPreparation && !reused) {
                reused = createTaskFixture(task.runtime, {
                  ...task,
                  sourceId: "source-filled-before-retention",
                });
              }
              const result = await mutate(
                context,
                command,
                () => {
                  assertCurrent();
                  if (revoked) {
                    throw new Error("Synthetic retention authority revoked after admission");
                  }
                },
                (owner) => {
                  grants += 1;
                  nativeOwner = owner;
                  // Native admission and settlement stay real; only receipt delivery is lost.
                  deliveredOwner = receiptUnavailable
                    ? {
                        get committed() {
                          return undefined;
                        },
                        get settlement() {
                          const settlement = owner.settlement;
                          return settlement && { kind: settlement.kind };
                        },
                        waitForSettlement(deadlineMs) {
                          const settlement = owner.waitForSettlement(deadlineMs);
                          return { kind: settlement.kind };
                        },
                      }
                    : owner;
                  onGranted?.(deliveredOwner);
                  revoked = failure === "authority is revoked before commit";
                },
              );
              if (resultDeliveryFails) {
                readbacksAtResultDelivery = readbacks.mock.calls.length;
                throw new Error("Synthetic retention result lost after native settlement");
              }
              return result;
            });
          const published: TaskRegistryObserverEvent[] = [];
          const stop = onTaskRegistryChange((event) => {
            if (event && event.kind !== "restored") {
              published.push(event);
            }
          });
          let maintenance: ReturnType<typeof runTaskRegistryMaintenance> | undefined;
          try {
            maintenance = runTaskRegistryMaintenance();
            const summary = await maintenance;
            expect(
              writes.mock.calls.filter(([, command]) => command.type === "tasks.applyRetention"),
            ).toHaveLength(1);
            expect(grants).toBe(sourceChangedAfterPreparation ? 0 : 1);
            if (metadataChanges || sourceChangedAfterPreparation) {
              expect(before.task.sourceId).toBeUndefined();
              expect(reused).toMatchObject({
                taskId: task.taskId,
                sourceId: "source-filled-before-retention",
                lastEventAt: before.task.lastEventAt,
              });
            }
            if (sourceChangedAfterPreparation) {
              expect(nativeOwner).toBeUndefined();
            } else {
              expect(expectDefined(nativeOwner, "native transaction owner").settlement?.kind).toBe(
                "completed",
              );
            }
            const committed = resultDeliveryFails;
            expect(summary).toEqual({
              reconciled: 0,
              recovered: 0,
              cleanupStamped: 0,
              pruned: committed && !receiptUnavailable ? 1 : 0,
            });
            const durable = loadTaskRegistryStateFromSqliteReadOnly();
            if (receiptUnavailable) {
              const owner = expectDefined(nativeOwner, "committed native transaction owner");
              expect(owner.committed?.facts).toBeDefined();
              expect(owner.settlement?.committed?.facts).toBeDefined();
              expect(deliveredOwner?.committed).toBeUndefined();
              expect(deliveredOwner?.settlement?.committed).toBeUndefined();
              expect(durable.tasks.has(task.taskId)).toBe(false);
              expect(durable.deliveryStates.has(task.taskId)).toBe(false);
              expect(tasks.get(task.taskId)).toEqual(before.task);
              expect(taskDeliveryStates.get(task.taskId)).toEqual(before.delivery);
              expect(taskMembership(task)).toEqual(before.membership);
              expect(taskActivityByTaskId.has(task.taskId)).toBe(true);
              expect(getTaskPreparedActivity(task.taskId)).toEqual(before.activity);
              expect(published).toEqual([]);
              expect(readbacks).toHaveBeenCalledTimes(readbacksAtResultDelivery);
              expect(isTaskRegistryTaskSettled(task.taskId)).toBe(false);

              const reconciled = expectDefined(
                await prepareTaskRegistryRead(),
                "separate canonical read after the unknown retention result",
              );
              expect(readbacks.mock.calls.length).toBeGreaterThan(readbacksAtResultDelivery);
              expect(reconciled.isTaskSettled(task.taskId)).toBe(true);
              expect(reconciled.getTaskById(task.taskId)).toBeUndefined();
              expect(tasks.has(task.taskId)).toBe(false);
              expect(taskDeliveryStates.has(task.taskId)).toBe(false);
              expect(taskMembership(task)).toEqual({
                owner: false,
                requester: false,
                child: false,
                run: false,
              });
              expect(taskActivityByTaskId.has(task.taskId)).toBe(false);
              expect(getTaskPreparedActivity(task.taskId)).toBeUndefined();
              expect(published).toEqual([]);
              expect(
                writes.mock.calls.filter(([, command]) => command.type === "tasks.applyRetention"),
              ).toHaveLength(1);
            } else if (committed) {
              const owner = expectDefined(nativeOwner, "committed native transaction owner");
              expect(owner.committed?.facts).toBeDefined();
              expect(owner.settlement?.committed?.facts).toBeDefined();
              expect(tasks.has(task.taskId)).toBe(false);
              expect(durable.tasks.has(task.taskId)).toBe(false);
              expect(taskDeliveryStates.has(task.taskId)).toBe(false);
              expect(durable.deliveryStates.has(task.taskId)).toBe(false);
              expect(taskMembership(task)).toEqual({
                owner: false,
                requester: false,
                child: false,
                run: false,
              });
              expect(taskActivityByTaskId.has(task.taskId)).toBe(false);
              expect(published).toEqual([
                ...(metadataChanges
                  ? [expect.objectContaining({ kind: "upserted", task: reused })]
                  : []),
                expect.objectContaining({
                  kind: "deleted",
                  taskId: task.taskId,
                  previous: expect.objectContaining({
                    lastEventAt: before.task.lastEventAt,
                    ...(metadataChanges ? { sourceId: "source-filled-before-retention" } : {}),
                  }),
                }),
              ]);
            } else {
              expect(nativeOwner?.committed).toBeUndefined();
              expect(nativeOwner?.settlement?.committed).toBeUndefined();
              const retained = sourceChangedAfterPreparation ? reused : before.task;
              expect(tasks.get(task.taskId)).toEqual(retained);
              expect(durable.tasks.get(task.taskId)).toEqual(retained);
              expect(taskDeliveryStates.get(task.taskId)).toEqual(before.delivery);
              expect(durable.deliveryStates.get(task.taskId)).toEqual(before.delivery);
              expect(taskMembership(task)).toEqual(before.membership);
              expect(getTaskPreparedActivity(task.taskId)).toEqual(before.activity);
              expect(published).toEqual(
                sourceChangedAfterPreparation
                  ? [expect.objectContaining({ kind: "upserted", task: retained })]
                  : [],
              );
            }
          } finally {
            await Promise.allSettled([maintenance]);
            preparation?.mockRestore();
            writes.mockRestore();
            readbacks.mockRestore();
            stop();
          }
        } finally {
          await closeOpenClawStateDatabaseAsync();
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
          await drainGlobalSingletonLifecycleState("close");
        }
      },
    );
  });
});
