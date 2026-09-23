import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { setTaskCronDeliveryEvidenceById } from "../../tasks/runtime-internal.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import {
  drainCronTaskDeliveryProjections,
  tryCreateCronTaskRunHandle,
  tryFinishCronTaskRun,
} from "./task-runs.js";

afterEach(async () => {
  await drainCronTaskDeliveryProjections();
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
});

it("projects command delivery status through the task worker", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-command-delivery-worker-" },
    async () => {
      resetTaskRegistryForTests();
      const startedAt = 2_000;
      const job: CronJob = {
        id: "command-delivery-worker",
        name: "command delivery worker",
        enabled: true,
        createdAtMs: 100,
        updatedAtMs: 100,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "command", argv: ["synthetic-command"] },
        state: { nextRunAtMs: 60_000 },
      };
      const state = createCronServiceState({
        storePath: "/tmp/jobs.json",
        cronEnabled: true,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs: () => startedAt + 100,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const taskRunId = tryCreateCronTaskRunHandle({ state, job, startedAt })?.runId;
      if (!taskRunId) {
        throw new Error("expected cron task run id");
      }
      const nativeDeliveryWrite = vi.spyOn(
        taskExecutor,
        "setDetachedTaskDeliveryStatusByRunIdCore",
      );

      tryFinishCronTaskRun(state, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          completionStatus: "failed",
          error: "synthetic delivery failure",
          delivered: false,
          deliveryStatus: "not-delivered",
          runAtMs: startedAt,
          durationMs: 100,
        },
      });

      expect(nativeDeliveryWrite).not.toHaveBeenCalled();
      await withTestTimeout(
        drainCronTaskDeliveryProjections(),
        5_000,
        "command delivery projection drained",
      );
      const [row] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
        runtime: "cron",
        sourceId: job.id,
      });
      expect(row).toMatchObject({
        status: "failed",
        deliveryStatus: "failed",
        detail: { kind: "cron-run", deliveryStatus: "not-delivered" },
      });
    },
  );
});

it("does not let a delayed command projection overwrite delivered evidence", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-command-delivery-race-" },
    async () => {
      resetTaskRegistryForTests();
      const startedAt = 3_000;
      const job: CronJob = {
        id: "command-delivery-race",
        name: "command delivery race",
        enabled: true,
        createdAtMs: 100,
        updatedAtMs: 100,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 100 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "command", argv: ["synthetic-command"] },
        state: { nextRunAtMs: 60_000 },
      };
      const state = createCronServiceState({
        storePath: "/tmp/jobs.json",
        cronEnabled: true,
        defaultAgentId: "main",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs: () => startedAt + 100,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const task = tryCreateCronTaskRunHandle({ state, job, startedAt });
      if (!task.taskId) {
        throw new Error("expected cron task id");
      }
      const intentId = `cron-command-delivery:v1:${task.taskId}`;

      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const projectionEntered = createDeferred();
      const releaseProjection = createDeferred();
      const projectionFinished = createDeferred();
      vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
        const delayedProjection = args[1].type === "tasks.setDeliveryStatus";
        if (delayedProjection) {
          projectionEntered.resolve();
          await releaseProjection.promise;
        }
        try {
          const result = await mutate(...args);
          if (delayedProjection) {
            projectionFinished.resolve();
          }
          return result;
        } catch (error) {
          if (delayedProjection) {
            projectionFinished.reject(error);
          }
          throw error;
        }
      });

      try {
        tryFinishCronTaskRun(state, {
          taskRunId: task.runId,
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: "error",
            completionStatus: "failed",
            error: "synthetic delivery failure",
            delivered: false,
            deliveryStatus: "not-delivered",
            runAtMs: startedAt,
            durationMs: 100,
          },
        });
        await withTestTimeout(projectionEntered.promise, 5_000, "pending projection entered");
        await expect(
          setTaskCronDeliveryEvidenceById({
            taskId: task.taskId,
            runId: task.runId,
            intentId,
            state: "delivered",
          }),
        ).resolves.toMatchObject({ deliveryStatus: "delivered" });
      } finally {
        releaseProjection.resolve();
      }
      await withTestTimeout(
        drainCronTaskDeliveryProjections(),
        5_000,
        "delayed command projection drained",
      );
      await withTestTimeout(projectionFinished.promise, 5_000, "delayed projection finished");
      await vi.waitFor(() => {
        const [row] = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(row).toMatchObject({
          deliveryStatus: "delivered",
          detail: { deliveryEvidence: { intentId, state: "delivered" } },
        });
      });
    },
  );
});
