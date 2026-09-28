import fs from "node:fs";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { readResidentTaskFlow } from "./task-flow-registry.js";
import { loadTaskFlowRegistryStateFromSqliteReadOnly } from "./task-flow-registry.store.sqlite.js";
import { createFlowRecord } from "./task-flow-registry.test-support.js";
import { loadTaskAcpSessionCloser } from "./task-registry-acp-cleanup.js";
import { taskAgentEventMutations } from "./task-registry-agent-events.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { tasks as residentTasks } from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import {
  configureTaskRegistryMaintenance,
  previewTaskRegistryMaintenance,
  reconcileInspectableTasks,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import {
  createTaskFixture,
  reloadTaskRegistryFromStoreAsync,
} from "./task-registry.test-support.js";
import { bindTaskRunOwner } from "./task-run-owner.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  setDetachedTaskLifecycleRuntime,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

async function withMaintenanceState(
  prefix: string,
  run: (state: OpenClawTestState) => Promise<void>,
) {
  await withOpenClawTestState({ layout: "state-only", prefix }, async (state) => {
    try {
      await run(state);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    }
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

describe("task maintenance session metadata", () => {
  it("retains a CLI task until its live run owner releases it", async () => {
    await withMaintenanceState("openclaw-task-maintenance-run-owner-", async () => {
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
      const task = createTaskFixture("cli", {
        runId: "retained-native-command",
        task: "Background command after its foreground turn",
        notifyPolicy: "silent",
        lastEventAt: Date.now() - 40 * 60_000,
      });
      const release = bindTaskRunOwner(task, async () => ({
        ok: false,
        error: "No cancellation requested in this scenario.",
      }));
      try {
        expect(reconcileInspectableTasks()).toContainEqual(
          expect.objectContaining({ taskId: task.taskId, status: "running" }),
        );
        expect(getTaskExecutionObservation(task)).toEqual({ state: "running" });
        expect(getTaskExecutionObservation({ ...task, runId: "replacement-command" })).toEqual({
          state: "unknown",
        });
        expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
        expect(getTaskById(task.taskId)?.status).toBe("running");

        release();
        expect(getTaskExecutionObservation(task)).toEqual({ state: "unknown" });
        expect((await runTaskRegistryMaintenance()).reconciled).toBe(1);
        expect(getTaskById(task.taskId)).toMatchObject({
          status: "lost",
          error: "backing session missing",
        });
      } finally {
        release();
      }
    });
  });

  it.each(["publication", "coordinator hold"] as const)(
    "retains task payloads without synchronous refreshes during %s",
    async (boundary) => {
      await withMaintenanceState("openclaw-task-maintenance-payloads-", async () => {
        resetTaskRegistryForTests({ persist: false });
        const now = Date.now();
        const detail = { maintenancePayload: "retained-task-payload".repeat(1024) };
        const retained = Array.from({ length: 30 }, (_, index) =>
          createTaskFixture("cli", {
            task: `Retained task ${index}`,
            runId: `retained-${index}`,
            status: "succeeded",
            cleanupAfter: now + 86_400_000,
            detail,
            notifyPolicy: "silent",
          }),
        );
        const expired = createTaskFixture("cli", {
          task: "Expired task",
          runId: "expired",
          status: "succeeded",
          cleanupAfter: now - 1,
          notifyPolicy: "silent",
        });
        const active = createTaskFixture("cli", {
          task: "Finish while maintenance waits for publication",
          runId: "maintenance-publication",
          cleanupAfter: now + 86_400_000,
          notifyPolicy: "silent",
        });
        await loadTaskAcpSessionCloser();
        emitAgentEvent({
          runId: active.runId!,
          stream: "tool",
          data: { phase: "start", name: "warmup" },
        });
        await prepareTaskRegistryRead();

        const store = getTaskRegistryStore();
        const readSnapshot = store.loadMutationSnapshotAsync.bind(store);
        const publicationPaused = createDeferred();
        const releasePublication = createDeferred();
        let held = false;
        vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
          const snapshot = await readSnapshot(...args);
          if (
            !held &&
            args[1] &&
            "taskId" in args[1] &&
            args[1].taskId === active.taskId &&
            snapshot.tasks.get(active.taskId)?.status === "succeeded"
          ) {
            held = true;
            publicationPaused.resolve();
            await releasePublication.promise;
          }
          return snapshot;
        });
        const syncSnapshots = vi.spyOn(store, "loadMutationSnapshot");
        const clone = vi.spyOn(globalThis, "structuredClone");
        const endedAt = Date.now();
        let holder: ReturnType<typeof holdStateDatabaseCoordinator> | undefined;
        let acceptedRead: ReturnType<typeof prepareTaskRegistryRead> | undefined;
        let maintenance: ReturnType<typeof runTaskRegistryMaintenance> | undefined;
        let summary: Awaited<ReturnType<typeof runTaskRegistryMaintenance>> | undefined;
        let releasedAtTimer: number | undefined;
        let synchronousReadsDuringHold = 0;
        const failures: unknown[] = [];
        const recordFailure = (error: unknown) => {
          if (!failures.includes(error)) {
            failures.push(error);
          }
        };
        try {
          emitAgentEvent({
            runId: active.runId!,
            stream: "tool",
            data: { phase: "start", name: "accepted" },
          });
          emitAgentEvent({
            runId: active.runId!,
            stream: "lifecycle",
            data: { phase: "end", endedAt },
          });
          acceptedRead = prepareTaskRegistryRead();
          void acceptedRead.catch(recordFailure);
          await withTestTimeout(
            publicationPaused.promise,
            5_000,
            "Terminal publication did not pause",
          );
          if (boundary === "coordinator hold") {
            const context = captureOpenClawStateWorkerContext();
            // The worker timeout only releases a regressed synchronous waiter.
            holder = holdStateDatabaseCoordinator(
              context.admission.databasePath,
              context.coordinatorRuntime,
              1_000,
            );
            await holder.ready;
          }
          const heldCoordinator = holder;
          const checkpoint = heldCoordinator
            ? sleep(0).then(() => Atomics.load(heldCoordinator.released, 0))
            : setImmediate().then(() => undefined);
          maintenance = runTaskRegistryMaintenance();
          void maintenance.catch(recordFailure);
          releasedAtTimer = await checkpoint;
          synchronousReadsDuringHold = syncSnapshots.mock.calls.length;
        } catch (error) {
          recordFailure(error);
        } finally {
          holder?.release();
          releasePublication.resolve();
          const settled = await Promise.allSettled([acceptedRead, maintenance, holder?.joined]);
          for (const result of settled) {
            if (result.status === "rejected") {
              recordFailure(result.reason);
            }
          }
          if (settled[1].status === "fulfilled") {
            summary = settled[1].value;
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Maintenance proof and cleanup failed", {
            cause: failures[0],
          });
        }

        if (boundary === "coordinator hold") {
          expect(releasedAtTimer).toBe(0);
        }
        expect(synchronousReadsDuringHold).toBe(0);
        expect(summary).toEqual({
          reconciled: 0,
          recovered: 0,
          cleanupStamped: 0,
          pruned: 1,
        });
        expect(
          clone.mock.calls.filter(
            ([value]) => value && typeof value === "object" && "maintenancePayload" in value,
          ),
        ).toHaveLength(0);
        expect(getTaskById(expired.taskId)).toBeUndefined();
        for (const task of retained) {
          expect(getTaskById(task.taskId)?.detail).toEqual(detail);
        }
        const terminal = {
          status: "succeeded",
          toolUseCount: 2,
          lastToolName: "accepted",
          endedAt,
        };
        expect(getTaskById(active.taskId)).toMatchObject(terminal);
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(active.taskId)).toMatchObject(
          terminal,
        );
      });
    },
  );

  it("prunes an expired sibling while a visible task creation is still publishing", async () => {
    await withMaintenanceState("openclaw-task-maintenance-pending-create-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const now = Date.now();
      const expired = createTaskFixture("cli", {
        task: "Older expired task",
        runId: "maintenance-expired-sibling",
        status: "succeeded",
        lastEventAt: now - 60_000,
        cleanupAfter: now - 1,
        notifyPolicy: "silent",
      });
      const flow = expectDefined(
        createFlowRecord({
          ownerKey: expired.ownerKey,
          syncMode: "task_mirrored",
          status: "queued",
          goal: "Pending creation flow",
          notifyPolicy: "silent",
        }),
        "queued parent flow",
      );
      await loadTaskAcpSessionCloser();
      await prepareTaskRegistryRead();

      const store = getTaskRegistryStore();
      const sync = store.syncLiveTaskFlowAsync.bind(store);
      const flowSynced = createDeferred<string>();
      const releasePublication = createDeferred();
      let held = false;
      let flowResult: Awaited<ReturnType<typeof sync>> | undefined;
      vi.spyOn(store, "syncLiveTaskFlowAsync").mockImplementation(async (...args) => {
        const result = await sync(...args);
        if (!held && args[1].flowId === flow.flowId) {
          held = true;
          flowResult = result;
          flowSynced.resolve(args[1].taskId);
          await releasePublication.promise;
        }
        return result;
      });
      const publishedTaskIds: string[] = [];
      const stop = onTaskRegistryChange((event) => {
        if (event?.kind === "upserted" && event.task.parentFlowId === flow.flowId) {
          publishedTaskIds.push(event.task.taskId);
        }
      });
      let creation: ReturnType<typeof createRunningTaskRunCoreWithReceiptAsync> | undefined;
      let created: Awaited<ReturnType<typeof createRunningTaskRunCoreWithReceiptAsync>> | undefined;
      let creationSettled = false;
      let maintenance: ReturnType<typeof runTaskRegistryMaintenance> | undefined;
      const failures: unknown[] = [];
      const recordFailure = (error: unknown) => {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      };
      try {
        creation = createRunningTaskRunCoreWithReceiptAsync({
          runtime: "cli",
          ownerKey: flow.ownerKey,
          scopeKind: "session",
          parentFlowId: flow.flowId,
          runId: "maintenance-pending-create",
          task: "Visible task awaiting flow publication",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        void creation.then(
          () => {
            creationSettled = true;
          },
          (error: unknown) => {
            creationSettled = true;
            recordFailure(error);
          },
        );
        const taskId = await withTestTimeout(
          flowSynced.promise,
          5_000,
          "Created task did not reach flow publication",
        );
        expect(flowResult).toMatchObject({
          kind: "result",
          result: { ok: true, flow: { flowId: flow.flowId, status: "running" } },
        });
        const pendingTask = structuredClone(
          expectDefined(residentTasks.get(taskId), "visible created task"),
        );
        expect(creationSettled).toBe(false);
        expect(publishedTaskIds).toEqual([]);

        maintenance = runTaskRegistryMaintenance();
        expect(
          await withTestTimeout(maintenance, 5_000, "Maintenance waited for pending publication"),
        ).toEqual({ reconciled: 0, recovered: 0, cleanupStamped: 0, pruned: 1 });
        expect(creationSettled).toBe(false);
        expect(publishedTaskIds).toEqual([]);
        const durable = loadTaskRegistryStateFromSqliteReadOnly();
        expect(residentTasks.has(expired.taskId)).toBe(false);
        expect(durable.tasks.has(expired.taskId)).toBe(false);
        expect(residentTasks.get(taskId)).toEqual(pendingTask);
        expect(durable.tasks.get(taskId)).toEqual(pendingTask);
      } catch (error) {
        recordFailure(error);
      } finally {
        releasePublication.resolve();
        const settled = await Promise.allSettled([creation, maintenance]);
        for (const result of settled) {
          if (result.status === "rejected") {
            recordFailure(result.reason);
          }
        }
        if (settled[0].status === "fulfilled") {
          created = settled[0].value;
        }
        stop();
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Maintenance creation proof and cleanup failed", {
          cause: failures[0],
        });
      }
      const task = expectDefined(created, "completed creation receipt").task;
      expect(publishedTaskIds).toEqual([task.taskId]);
      expect(residentTasks.get(task.taskId)).toEqual(task);
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toEqual(task);
      const publishedFlow = { flowId: flow.flowId, status: "running", goal: task.task };
      expect(readResidentTaskFlow(flow.flowId)).toMatchObject(publishedFlow);
      expect(loadTaskFlowRegistryStateFromSqliteReadOnly().flows.get(flow.flowId)).toMatchObject(
        publishedFlow,
      );
      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
    });
  });

  it.each(["generated", "padded"] as const)(
    "settles progress accepted after the initial read fence before recovering a %s task ID",
    async (identity) => {
      await withMaintenanceState("openclaw-task-maintenance-late-progress-", async () => {
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
        const staleAt = Date.now() - 45 * 60_000;
        const created = createTaskFixture("cli", {
          task: "Keep working while maintenance selects the task",
          runId: "maintenance-late-progress",
          lastEventAt: staleAt,
          notifyPolicy: "silent",
        });
        const task =
          identity === "padded" ? { ...created, taskId: ` ${created.taskId} ` } : created;
        const store = getTaskRegistryStore();
        if (identity === "padded") {
          const deliveryState = store.loadSnapshot().deliveryStates.get(created.taskId);
          store.upsertTaskWithDeliveryState({
            task,
            ...(deliveryState ? { deliveryState: { ...deliveryState, taskId: task.taskId } } : {}),
          });
          store.deleteTaskWithDeliveryState(created.taskId);
          await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        }
        await loadTaskAcpSessionCloser();
        await prepareTaskRegistryRead();

        const progressEntered = createDeferred();
        const releaseProgress = createDeferred();
        const selectionReached = createDeferred();
        let progressHeld = false;
        let progressAt: number | undefined;
        const mutate = store.runAgentEventMutationAsync.bind(store);
        vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
          if (!progressHeld && args[1].taskId === task.taskId) {
            progressHeld = true;
            progressAt = args[1].change.at;
            progressEntered.resolve();
            await releaseProgress.promise;
          }
          return mutate(...args);
        });
        const recoveryHook = vi.fn(async () => {
          selectionReached.resolve();
          return { recovered: false };
        });
        setDetachedTaskLifecycleRuntime({
          ...getDetachedTaskLifecycleRuntime(),
          tryRecoverTaskBeforeMarkLost: recoveryHook,
        });
        const capture = taskAgentEventMutations.captureReadFence.bind(taskAgentEventMutations);
        let capturedFences = 0;
        let initialFenceReturned = false;
        let preparedAgain = false;
        vi.spyOn(taskAgentEventMutations, "captureReadFence").mockImplementation(
          async (...args) => {
            const fence = capture(...args);
            capturedFences += 1;
            if (capturedFences === 1) {
              // This event is outside the captured prefix but precedes task selection.
              emitAgentEvent({
                runId: task.runId!,
                stream: "tool",
                data: { phase: "start", name: "still-working" },
              });
              await Promise.all([fence, progressEntered.promise]);
              initialFenceReturned = true;
            } else {
              preparedAgain = true;
              selectionReached.resolve();
              await fence;
            }
          },
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
          maintenance = runTaskRegistryMaintenance();
          void maintenance.catch(recordFailure);
          await withTestTimeout(
            selectionReached.promise,
            5_000,
            "Maintenance did not select beyond its initial read fence",
          );
          expect(progressHeld).toBe(true);
          expect(initialFenceReturned).toBe(true);
          expect(recoveryHook).not.toHaveBeenCalled();
          expect(preparedAgain).toBe(true);
        } catch (error) {
          recordFailure(error);
        } finally {
          releaseProgress.resolve();
          progressEntered.resolve();
          const settled = await Promise.allSettled([maintenance, prepareTaskRegistryRead()]);
          for (const result of settled) {
            if (result.status === "rejected") {
              recordFailure(result.reason);
            }
          }
          if (settled[0].status === "fulfilled") {
            summary = settled[0].value;
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Maintenance progress proof and cleanup failed", {
            cause: failures[0],
          });
        }
        expect(summary).toEqual({ reconciled: 0, recovered: 0, cleanupStamped: 0, pruned: 0 });
        expect(recoveryHook).not.toHaveBeenCalled();
        expect(progressAt).toBeGreaterThan(staleAt);
        const current = {
          taskId: task.taskId,
          status: "running",
          lastEventAt: progressAt,
          toolUseCount: 1,
          lastToolName: "still-working",
        };
        const durable = loadTaskRegistryStateFromSqliteReadOnly();
        expect([...residentTasks.keys()]).toEqual([task.taskId]);
        expect([...durable.tasks.keys()]).toEqual([task.taskId]);
        expect(residentTasks.get(task.taskId)).toMatchObject(current);
        expect(durable.tasks.get(task.taskId)).toMatchObject(current);
      });
    },
  );

  it("reconciles backing and wedged children without decoding their saved prompts", async () => {
    await withMaintenanceState("openclaw-task-maintenance-metadata-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const staleAt = Date.now() - 45 * 60_000;
      for (const agentId of ["main", "worker"]) {
        for (const suffix of ["healthy", "wedged", "unrelated"]) {
          replaceSessionEntrySync(
            { agentId, sessionKey: `agent:${agentId}:subagent:${suffix}` },
            {
              sessionId: `${agentId}-${suffix}`,
              updatedAt: staleAt,
              ...(suffix === "unrelated" ? { label: "maintenance-unrelated-row" } : {}),
              skillsSnapshot: { prompt: "maintenance-proof-saved-prompt".repeat(1024), skills: [] },
              ...(suffix === "wedged"
                ? { subagentRecovery: { wedgedAt: staleAt, wedgedReason: "Recovery tombstoned" } }
                : {}),
            },
          );
        }
      }
      const tasks = ["healthy", "wedged", "missing"].map((suffix) =>
        createTaskFixture("subagent", {
          task: `Check ${suffix}`,
          runId: `maintenance-${suffix}`,
          childSessionKey: `agent:worker:subagent:${suffix}`,
          lastEventAt: staleAt,
          notifyPolicy: "silent",
        }),
      );
      const parse = vi.spyOn(JSON, "parse");
      expect(previewTaskRegistryMaintenance().reconciled).toBe(2);
      expect(
        parse.mock.calls.filter(([json]) => json.includes("maintenance-unrelated-row")),
      ).toHaveLength(0);
      expect(reconcileInspectableTasks().map(({ status, error }) => ({ status, error }))).toEqual(
        expect.arrayContaining([
          { status: "running", error: undefined },
          { status: "lost", error: "Recovery tombstoned" },
          { status: "lost", error: "backing session missing" },
        ]),
      );
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 2 });
      expect(tasks.map((task) => getTaskById(task.taskId)?.status)).toEqual([
        "running",
        "lost",
        "lost",
      ]);
      expect(
        parse.mock.calls.filter(([json]) => json.includes("maintenance-proof-saved-prompt")).length,
      ).toBe(0);
    });
  });
  it.each(["warm", "warm alias", "cold"] as const)(
    "keeps %s corrupt-row admission while reconciling healthy siblings",
    async (admission) => {
      await withMaintenanceState("openclaw-task-maintenance-corruption-", async (state) => {
        const stateDir = admission === "warm alias" ? state.path("alias") : state.stateDir;
        if (admission === "warm alias") {
          fs.symlinkSync(state.stateDir, stateDir, "junction");
        }
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          resetTaskRegistryForTests({ persist: false });
          const staleAt = Date.now() - 45 * 60_000;
          const tasks = ["healthy", "corrupt"].map((suffix) => {
            const sessionKey = `agent:main:subagent:${suffix}`;
            replaceSessionEntrySync({ sessionKey }, { sessionId: suffix, updatedAt: staleAt });
            return createTaskFixture("subagent", {
              task: `Check ${suffix}`,
              runId: `maintenance-${suffix}`,
              childSessionKey: sessionKey,
              lastEventAt: staleAt,
              notifyPolicy: "silent",
            });
          });
          expect(previewTaskRegistryMaintenance().reconciled).toBe(0);
          // Existing warm listings skip malformed rows; exact reads intentionally throw.
          openOpenClawAgentDatabase({ agentId: "main" })
            .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run("{", "agent:main:subagent:corrupt");
          if (admission === "cold") {
            await closeOpenClawAgentDatabaseByPathAsync(
              openOpenClawAgentDatabase({ agentId: "main" }).path,
            );
            expect(() => previewTaskRegistryMaintenance()).toThrow(/canonical|repair/i);
            await expect(runTaskRegistryMaintenance()).rejects.toThrow(/canonical|repair/i);
            expect(tasks.map((task) => getTaskById(task.taskId)?.status)).toEqual([
              "running",
              "running",
            ]);
            return;
          }
          expect(previewTaskRegistryMaintenance().reconciled).toBe(1);
          expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
          expect(tasks.map((task) => getTaskById(task.taskId)?.status)).toEqual([
            "running",
            "lost",
          ]);
        });
      });
    },
  );

  it("rejects delivery-canonical drift in an unrequested warm sibling", async () => {
    await withMaintenanceState("openclaw-task-maintenance-canonical-sibling-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const staleAt = Date.now() - 45 * 60_000;
      const sibling = "agent:main:matrix:channel:!room:example.org";
      replaceSessionEntrySync(
        { sessionKey: sibling },
        { sessionId: "sibling", updatedAt: staleAt },
      );
      const task = createTaskFixture("subagent", {
        task: "Missing child",
        childSessionKey: "agent:main:subagent:missing",
        lastEventAt: staleAt,
        notifyPolicy: "silent",
      });
      expect(previewTaskRegistryMaintenance().reconciled).toBe(1);
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({
            sessionId: "sibling",
            updatedAt: staleAt,
            delivery: {
              kind: "external",
              route: { channel: "matrix", target: { to: "!Room:example.org" } },
              context: { channel: "matrix", to: "!Room:example.org" },
            },
          }),
          sibling,
        );
      expect(() => previewTaskRegistryMaintenance()).toThrow(/non-canonical persisted row/);
      await expect(runTaskRegistryMaintenance()).rejects.toThrow(/non-canonical persisted row/);
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });

  it("sees backing metadata repaired by the recovery hook", async () => {
    await withMaintenanceState("openclaw-task-maintenance-recovery-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const staleAt = Date.now() - 45 * 60_000;
      const scope = { sessionKey: "agent:main:subagent:recovered" };
      replaceSessionEntrySync(scope, {
        sessionId: "recovered",
        updatedAt: staleAt,
        subagentRecovery: { wedgedAt: staleAt },
      });
      const task = createTaskFixture("subagent", {
        task: "Recover child",
        runId: "maintenance-recovered",
        childSessionKey: scope.sessionKey,
        lastEventAt: staleAt,
        notifyPolicy: "silent",
      });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: async () => {
          await Promise.resolve();
          replaceSessionEntrySync(scope, { sessionId: "recovered", updatedAt: Date.now() });
          return { recovered: false };
        },
      });
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });
});
