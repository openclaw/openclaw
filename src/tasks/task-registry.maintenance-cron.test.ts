import { setImmediate } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearCronJobActive, markCronJobActive, resetCronActiveJobs } from "../cron/active-jobs.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import { createTaskFlowForTask, readResidentTaskFlow } from "./task-flow-registry.js";
import { loadTaskAcpSessionCloser } from "./task-registry-acp-cleanup.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { taskDeliveryStates, tasks } from "./task-registry-state.js";
import {
  configureTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.types.js";
import {
  createTaskFixture,
  prepareTaskFixtureRead,
  reloadTaskRegistryFromStoreAsync,
} from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "./task-runtime.test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  resetCronActiveJobs();
  resetDetachedTaskLifecycleRuntimeForTests();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

async function withCronMaintenanceState(run: () => Promise<void>) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-cron-maintenance-" },
    async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
      try {
        await run();
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
}

function seedCronRecovery(status: "running" | "lost", suffix: string) {
  const now = Date.now();
  const created = createTaskFixture("cron", {
    sourceId: `synthetic-cron-${suffix}`,
    runId: `synthetic-cron-run-${suffix}`,
    task: "Synthetic retained cron execution",
    status,
    startedAt: now - 600_000,
    lastEventAt: now - 500_000,
    cleanupAfter: now + 86_400_000,
    notifyPolicy: "silent",
    requesterOrigin: { channel: "discord", to: "channel:synthetic-cron-maintenance" },
  });
  const flow = expectDefined(createTaskFlowForTask({ task: created }), "mirrored task flow");
  const target = { ...created, parentFlowId: flow.flowId, error: "backing session missing" };
  const delivery = structuredClone(
    expectDefined(taskDeliveryStates.get(target.taskId), "target delivery bookkeeping"),
  );
  getTaskRegistryStore().upsertTaskWithDeliveryState({ task: target, deliveryState: delivery });
  const source: TaskRecord = {
    ...target,
    taskId: `${target.taskId}-durable-source`,
    createdAt: target.createdAt - 1,
    status: "cancelled",
    endedAt: now - 400_000,
    lastEventAt: now - 400_000,
    parentFlowId: undefined,
    error: undefined,
    terminalSummary: "Cancelled\n  exact durable summary\n",
    detail: { kind: "cron-run", status: "error", durationMs: 50_000 },
  };
  // Seed the prior same-run ledger row directly: normal creation deduplicates a run.
  getTaskRegistryStore().upsertTaskWithDeliveryState({ task: source });
  return { target, source, delivery, flow };
}

async function prepareCronFixtures(fixtures: Array<{ target: TaskRecord }>) {
  const context = captureOpenClawStateWorkerContext();
  await reloadTaskRegistryFromStoreAsync(context);
  await loadTaskAcpSessionCloser();
  await prepareTaskRegistryRead();
  for (const { target } of fixtures) {
    await prepareTaskFixtureRead(target);
  }
  return context;
}

function expectRecovered(
  fixture: ReturnType<typeof seedCronRecovery>,
  durable: ReturnType<typeof loadTaskRegistryStateFromSqliteReadOnly>,
) {
  const { target, source, delivery } = fixture;
  const current = expectDefined(tasks.get(target.taskId), "recovered resident task");
  expect(current).toMatchObject({
    taskId: target.taskId,
    status: source.status,
    endedAt: source.endedAt,
    terminalSummary: source.terminalSummary,
    detail: source.detail,
    cleanupAfter: target.cleanupAfter,
  });
  expect(current.error).toBeUndefined();
  if (target.status === "lost") {
    expect(current.lastEventAt).toBeGreaterThan(
      expectDefined(target.lastEventAt, "selected last event"),
    );
  } else {
    expect(current.lastEventAt).toBe(source.lastEventAt);
  }
  expect(durable.tasks.get(target.taskId)).toEqual(current);
  expect(taskDeliveryStates.get(target.taskId)).toEqual(delivery);
  expect(durable.deliveryStates.get(target.taskId)).toEqual(delivery);
  expect(durable.tasks.get(source.taskId)).toEqual(source);
  expect(readResidentTaskFlow(fixture.flow.flowId)).toMatchObject({ status: "cancelled" });
}

describe("durable cron task maintenance", () => {
  it("recovers active and lost tasks from an earlier same-run ledger row without changing delivery", async () => {
    await withCronMaintenanceState(async () => {
      const fixtures = [seedCronRecovery("running", "running"), seedCronRecovery("lost", "lost")];
      await prepareCronFixtures(fixtures);
      const native = requireNodeSqlite();
      using hostPrepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
      const summary = await runTaskRegistryMaintenance();
      expect(
        hostPrepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => /\b(?:task_runs|task_delivery_state|flow_runs)\b/u.test(sql)),
      ).toEqual([]);
      expect(summary).toEqual({ reconciled: 0, recovered: 2, cleanupStamped: 0, pruned: 0 });
      const durable = loadTaskRegistryStateFromSqliteReadOnly();
      for (const fixture of fixtures) {
        expectRecovered(fixture, durable);
      }
    });
  });

  it.each([false, true])(
    "keeps recovery responsive under foreign writer custody and rechecks reactivation=%s",
    async (reactivate) => {
      await withCronMaintenanceState(async () => {
        const fixture = seedCronRecovery("running", `contention-${reactivate}`);
        const context = await prepareCronFixtures([fixture]);
        const before = structuredClone(
          expectDefined(tasks.get(fixture.target.taskId), "resident target"),
        );
        const published: TaskRegistryObserverEvent[] = [];
        const stop = onTaskRegistryChange((event) => {
          if (event && event.kind !== "restored") {
            published.push(event);
          }
        });
        const dispatched = createDeferred();
        const observedDispatch = vi.spyOn(Worker.prototype, "postMessage");
        Worker.prototype.postMessage = function (
          this: Worker,
          ...args: Parameters<Worker["postMessage"]>
        ) {
          observedDispatch.call(this, ...args);
          const [message] = args;
          if (
            isRecord(message) &&
            message.type === "execute" &&
            message.input instanceof Uint8Array &&
            message.stateDatabasePath === context.admission.databasePath
          ) {
            const command: unknown = deserialize(message.input);
            if (
              isRecord(command) &&
              command.type === "tasks.maintainCron" &&
              isRecord(command.input) &&
              command.input.taskId === fixture.target.taskId
            ) {
              dispatched.resolve();
            }
          }
        };
        // Only a deadlock escape hatch; success releases custody explicitly below.
        const holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 1_000);
        let maintenance: ReturnType<typeof runTaskRegistryMaintenance> | undefined;
        let maintenanceSettled = false;
        let summary: Awaited<ReturnType<typeof runTaskRegistryMaintenance>> | undefined;
        const failures: unknown[] = [];
        try {
          await holder.ready;
          maintenance = runTaskRegistryMaintenance();
          void maintenance
            .finally(() => {
              maintenanceSettled = true;
            })
            .catch(() => undefined);
          await Promise.race([
            dispatched.promise,
            maintenance.then(() => {
              throw new Error("Maintenance completed without contended cron recovery");
            }),
            holder.joined.then(() => {
              throw new Error("SQLite writer custody escaped before cron recovery dispatch");
            }),
          ]);
          await setImmediate();
          await setImmediate();
          expect(Atomics.load(holder.released, 0)).toBe(0);
          expect(maintenanceSettled).toBe(false);
          expect(tasks.get(before.taskId)).toEqual(before);
          expect(taskDeliveryStates.get(before.taskId)).toEqual(fixture.delivery);
          expect(published).toEqual([]);
          if (reactivate) {
            markCronJobActive(expectDefined(fixture.target.sourceId, "cron job id"));
          }
        } catch (error) {
          failures.push(error);
        } finally {
          holder.release();
          const settled = await Promise.allSettled([maintenance, holder.joined]);
          for (const result of settled) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
          if (settled[0].status === "fulfilled") {
            summary = settled[0].value;
          }
          clearCronJobActive(expectDefined(fixture.target.sourceId, "cron job id"));
          observedDispatch.mockRestore();
          stop();
        }
        if (failures.length) {
          throw new AggregateError(failures, "Cron maintenance proof or cleanup failed");
        }
        expect(summary).toEqual({
          reconciled: 0,
          recovered: reactivate ? 0 : 1,
          cleanupStamped: 0,
          pruned: 0,
        });
        const durable = loadTaskRegistryStateFromSqliteReadOnly();
        if (reactivate) {
          expect(tasks.get(before.taskId)).toEqual(before);
          expect(durable.tasks.get(before.taskId)).toEqual(before);
          expect(published).toEqual([]);
        } else {
          expectRecovered(fixture, durable);
          expect(published).toContainEqual(
            expect.objectContaining({
              kind: "upserted",
              task: expect.objectContaining({
                taskId: before.taskId,
                status: "cancelled",
                endedAt: fixture.source.endedAt,
                terminalSummary: fixture.source.terminalSummary,
              }),
            }),
          );
        }
      });
    },
  );

  it.each([false, true])(
    "publishes a runless peer completion with existing retention=%s",
    async (retentionPresent) => {
      await withCronMaintenanceState(async () => {
        const created = createTaskFixture("cron", {
          sourceId: "synthetic-runless-late-result",
          task: "Synthetic runless retained execution",
          lastEventAt: Date.now() - 600_000,
          notifyPolicy: "silent",
          requesterOrigin: { channel: "discord", to: "channel:synthetic-cron-maintenance" },
        });
        const flow = expectDefined(createTaskFlowForTask({ task: created }), "mirrored peer flow");
        const target = { ...created, parentFlowId: flow.flowId };
        expect(target.runId).toBeUndefined();
        const delivery = structuredClone(
          expectDefined(taskDeliveryStates.get(target.taskId), "delivery bookkeeping"),
        );
        getTaskRegistryStore().upsertTaskWithDeliveryState({
          task: target,
          deliveryState: delivery,
        });
        await prepareCronFixtures([{ target }]);
        const endedAt = Date.now();
        const cleanupAfter = endedAt + 7 * 24 * 60 * 60_000;
        const terminal: TaskRecord = {
          ...target,
          status: "succeeded",
          endedAt,
          lastEventAt: endedAt,
          terminalSummary: "late\n  durable outcome",
          detail: { kind: "cron-run", status: "ok" },
          ...(retentionPresent ? { cleanupAfter } : {}),
        };
        const hook = vi.fn(async () => {
          await Promise.resolve();
          getTaskRegistryStore().upsertTaskWithDeliveryState({
            task: terminal,
            deliveryState: delivery,
          });
          return { recovered: false };
        });
        setDetachedTaskLifecycleRuntime({
          ...getDetachedTaskLifecycleRuntime(),
          tryRecoverTaskBeforeMarkLost: hook,
        });
        const store = getTaskRegistryStore();
        using mutationResults = vi.spyOn(store, "runInitialMutationAsync");
        const summary = await runTaskRegistryMaintenance();
        expect(hook).toHaveBeenCalledOnce();
        const receipts = await Promise.all(
          mutationResults.mock.results.flatMap((result, index) =>
            mutationResults.mock.calls[index]?.[1].type === "tasks.maintainCron" &&
            result.type === "return"
              ? [result.value]
              : [],
          ),
        );
        expect(receipts.filter((result) => result !== null)).toEqual([
          expect.objectContaining({ persisted: !retentionPresent }),
        ]);
        expect(summary).toEqual({ reconciled: 0, recovered: 1, cleanupStamped: 0, pruned: 0 });
        expect(tasks.get(target.taskId)).toMatchObject({
          taskId: target.taskId,
          status: terminal.status,
          endedAt,
          lastEventAt: endedAt,
          task: terminal.task,
          terminalSummary: terminal.terminalSummary,
          detail: terminal.detail,
        });
        expect(tasks.get(target.taskId)?.cleanupAfter).toBe(cleanupAfter);
        expect(readResidentTaskFlow(flow.flowId)).toMatchObject({ status: "succeeded" });
        const durable = loadTaskRegistryStateFromSqliteReadOnly();
        expect(durable.tasks.get(target.taskId)).toEqual(tasks.get(target.taskId));
        expect(durable.deliveryStates.get(target.taskId)).toEqual(delivery);
      });
    },
  );
});
