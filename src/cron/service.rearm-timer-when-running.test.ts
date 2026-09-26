import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createNoopLogger, createCronStoreHarness } from "./service.test-harness.js";
import { stop } from "./service/ops-lifecycle.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { makeStorePath } = createCronStoreHarness();

function recurringJob(id: string, nowMs: number, nextRunAtMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs },
  };
}

describe("cron wakes during active execution", () => {
  it("runs later due work while an earlier scheduled run is still executing", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const started = createDeferred();
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const laterFinished = createDeferred();
    const laterJob = recurringJob("later-job", now, now + 10_000);
    laterJob.sessionTarget = "main";
    laterJob.payload = { kind: "systemEvent", text: "later work" };
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [recurringJob("long-running-job", now, now), laterJob],
    });
    const runIsolatedAgentJob = vi.fn(async () => {
      started.resolve();
      return await deferredRun.promise;
    });
    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      scheduler,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.jobId === "later-job" && event.action === "finished") {
          laterFinished.resolve();
        }
      },
    });

    const timerPromise = onTimer(state);
    let laterWake: ReturnType<typeof clock.advanceTo> = undefined;
    try {
      await started.promise;
      expect(state.running).toBe(true);
      expect(scheduler.nextWakeAtMs).not.toBeNull();

      laterWake = clock.advanceTo(now + 10_000);
      await laterFinished.promise;

      expect(enqueueSystemEvent).toHaveBeenCalledWith("later work", expect.any(Object));
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.running).toBe(true);
    } finally {
      deferredRun.resolve({ status: "ok", summary: "done" });
      await timerPromise;
      await laterWake;
      stop(state);
      await scheduler.stop();
    }
    expect(state.running).toBe(false);
  });
});
