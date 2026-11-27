import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  getGatewaySuspendAdmissionPhase,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { cronTestDeps, cronTestJob } from "./service.fixture-builders.test-support.js";
import { createCronStoreHarness } from "./service.test-harness.js";
import { stop } from "./service/ops-lifecycle.js";
import { startCronScheduler } from "./service/scheduler-actor.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";
import { createCronServiceState, type CronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-tight-loop-" });
const now = Date.parse("2026-02-28T12:32:00.000Z");

describe("cron scheduled wakes", () => {
  const states: CronServiceState[] = [];

  afterEach(() => {
    for (const state of states) {
      stop(state);
    }
    states.length = 0;
  });

  it("joins admission-blocked ticks without reopening suspension", async ({ signal }) => {
    const store = await makeStorePath();
    const clock = createGatewaySchedulerClock(now);
    const state = createCronServiceState({
      ...cronTestDeps({ storePath: store.storePath }),
      nowMs: () => clock.clock.now(),
      scheduler: createTestGatewayScheduler(clock.clock),
    });
    states.push(state);
    const job = cronTestJob({
      id: "monitor",
      schedule: { kind: "cron", expr: "*/15 * * * *" },
      state: { nextRunAtMs: now + 1_000 },
    });
    state.store = { version: 1, jobs: [job] };
    await saveCronStore(store.storePath, state.store);
    const { wake: wakeScheduler } = await captureCronSchedulerWakeForTest(() =>
      startCronScheduler(state, new Set()),
    );
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const releaseSuspension = () => {
      suspension?.release();
    };
    signal.addEventListener("abort", releaseSuspension, { once: true });
    const wake = wakeScheduler(state);

    try {
      state.deps.scheduler.beginClose();
      stop(state);
      await state.schedulerDrain;
      await state.deps.scheduler.stop();
      await wake;

      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(state.deps.log.error).not.toHaveBeenCalled();
    } finally {
      signal.removeEventListener("abort", releaseSuspension);
      releaseSuspension();
      await wake;
    }
  });
});
