import { deserialize } from "node:v8";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { tryBeginGatewaySuspendAdmission } from "../../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { releaseLocalCronRunReceiptOwnership } from "../store/run-receipt-store.js";
import type { CronRuntimeMutationType } from "../store/runtime-worker.types.js";
import { start, stop } from "./ops-lifecycle.js";
import { claimCronRecoveryReceipt } from "./run-recovery.test-support.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { onTimer } from "./timer-scheduler.js";

function delayCronAdmission(
  type: CronRuntimeMutationType,
  stage: "transaction" | "commit",
  count = 1,
) {
  const held = createDeferred();
  const delayed: Array<() => void> = [];
  const nonces = new Set<string>();
  const restores: Array<() => void> = [];
  const create = workerCpu.createCpuTrackedWorker;
  const created = vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = create(...args);
    const post = worker.postMessage.bind(worker);
    const posted = vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
      const request: unknown = message;
      if (isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array) {
        const command: unknown = deserialize(request.input);
        if (
          isRecord(command) &&
          command.type === type &&
          isRecord(command.input) &&
          typeof command.input.nonce === "string"
        ) {
          nonces.add(command.input.nonce);
        }
      }
      return post(message, transferList);
    });
    restores.push(() => posted.mockRestore());
    return worker;
  });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admissions = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) => {
      const listening = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
        this: MessagePort,
        event,
        listener,
      ) {
        if (event !== "message") {
          return this.addListener(event, listener);
        }
        return this.addListener("message", function (this: MessagePort, message: unknown) {
          if (
            delayed.length < count &&
            isRecord(message) &&
            message.stage === stage &&
            isRecord(message.facts) &&
            typeof message.facts.nonce === "string" &&
            nonces.has(message.facts.nonce)
          ) {
            // Delay the receiver, preserving the worker's real shared decision and rollback.
            delayed.push(() => listener.call(this, message));
            held.resolve();
            return;
          }
          listener.call(this, message);
        });
      });
      try {
        return createAdmission(admit, attachment);
      } finally {
        listening.mockRestore();
      }
    });
  return {
    held: held.promise,
    get count() {
      return delayed.length;
    },
    release() {
      for (const deliver of delayed.splice(0)) {
        deliver();
      }
    },
    restore() {
      admissions.mockRestore();
      created.mockRestore();
      for (const restore of restores.toReversed()) {
        restore();
      }
    },
  };
}

for (const { phase, type, stage } of [
  { phase: "startup settlement", type: "cron.releaseReservations", stage: "transaction" },
  { phase: "startup settlement", type: "cron.releaseReservations", stage: "commit" },
  { phase: "startup recovery", type: "cron.repairRun", stage: "commit" },
] as const) {
  it(`retries ${phase} after delayed ${stage} admission without losing a one-shot`, async ({
    signal,
  }) => {
    await withOpenClawTestState({ label: "cron-startup-admission-timeout" }, async (fixture) => {
      const fault = delayCronAdmission(type, stage);
      const now = Date.now();
      const clock = createGatewaySchedulerClock(now);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "delayed-startup", nowMs: now, nextRunAtMs: now });
      if (phase === "startup recovery") {
        job.state.runningAtMs = now;
      }
      const log = { ...noopLogger, warn: vi.fn() };
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        scheduler,
        storePath,
        nowMs: clock.clock.now,
        defaultAgentId: "main",
        startupDeferredMissedAgentJobDelayMs: 0,
        missedJobStaggerMs: 0,
        runIsolatedAgentJob: runner,
        log,
      });
      try {
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        if (phase === "startup recovery") {
          releaseLocalCronRunReceiptOwnership(
            claimCronRecoveryReceipt(storePath, job, now, "main"),
          );
        }
        const database = openOpenClawStateDatabase().db;
        const started = start(state);
        await withinTest(fault.held, signal);
        // MAIN cannot service admission while this competing native writer waits.
        runWithSqliteBusyTimeout(database, 2_000, () => {
          database.exec("BEGIN IMMEDIATE");
          database.exec("ROLLBACK");
        });
        await withinTest(started, signal);
        expect(fault.count).toBe(1);
        expect(log.warn).toHaveBeenCalledWith(
          { err: expect.stringContaining("admission") },
          "cron: startup admission delayed; retrying later",
        );
        expect(runner).not.toHaveBeenCalled();
        const pending = (await loadCronStore(storePath)).jobs[0];
        expect(pending?.enabled).toBe(true);
        expect(pending?.state.nextRunAtMs).toBe(now);
        fault.release();
        fault.restore();
        if (phase === "startup recovery") {
          const scheduled = vi.fn();
          state.deps.runSchedulerOwned = async (run) => {
            scheduled();
            return await run();
          };
          const suspension = tryBeginGatewaySuspendAdmission(() => {});
          try {
            expect(suspension?.commit()).toBe(true);
            const retry = clock.advanceBy(MIN_REFIRE_GAP_MS);
            expect(scheduled).not.toHaveBeenCalled();
            expect(runner).not.toHaveBeenCalled();
            expect(suspension?.release()).toBe(true);
            await retry;
            expect(scheduled).toHaveBeenCalledOnce();
          } finally {
            suspension?.release();
            suspension?.rollback();
          }
        } else {
          await clock.advanceBy(MIN_REFIRE_GAP_MS);
        }
        await clock.advanceBy(MIN_REFIRE_GAP_MS);
        expect(runner).toHaveBeenCalledTimes(1);
        expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
        expect(state.startupCatchup).toBeUndefined();
      } finally {
        fault.release();
        fault.restore();
        stop(state);
        await scheduler.stop();
      }
    });
  });
}

it("recovers queued work after both reservation cleanup attempts time out", async ({ signal }) => {
  await withOpenClawTestState({ label: "cron-release-admission-timeout" }, async (fixture) => {
    const fault = delayCronAdmission("cron.releaseReservations", "commit", 3);
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "delayed-release", nowMs: now, nextRunAtMs: now });
    const log = { ...noopLogger, warn: vi.fn() };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      scheduler,
      storePath,
      nowMs: clock.clock.now,
      defaultAgentId: "main",
      runIsolatedAgentJob: runner,
      log,
    });
    let stopObserving: (() => void) | undefined;
    try {
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const database = openOpenClawStateDatabase().db;
      stopObserving = observeCronStoreCommits(storePath, () => {
        if (!state.queuedRunReservationsByJobId.has(job.id)) {
          database
            .prepare(
              "UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', ?) WHERE store_key = ? AND job_id = ?",
            )
            .run(now + 60_000, cronStoreKey(storePath), job.id);
        }
      });
      const tick = onTimer(state);
      await withinTest(fault.held, signal);
      await withinTest(tick, signal);
      expect(fault.count).toBe(3);
      database.exec("BEGIN IMMEDIATE");
      database.exec("ROLLBACK");
      expect(runner).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBe(now);
      expect(log.warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("admission") },
        "cron: worker admission delayed; retrying later",
      );
      stopObserving();
      fault.release();
      fault.restore();
      await clock.advanceBy(60_000);
      expect(runner).toHaveBeenCalledTimes(1);
      expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
    } finally {
      stopObserving?.();
      fault.release();
      fault.restore();
      stop(state);
      await scheduler.stop();
    }
  });
});
