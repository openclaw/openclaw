import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  getGatewaySuspendAdmissionPhase,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createNoopLogger, createCronStoreHarness } from "./service.test-harness.js";
import { stop } from "./service/ops-lifecycle.js";
import { startCronScheduler } from "./service/scheduler-actor.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";
import { createCronServiceState, type CronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-tight-loop-" });
const now = Date.parse("2026-02-28T12:32:00.000Z");

function job(nextRunAtMs?: number): CronJob {
  return {
    id: "monitor",
    name: "monitor",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "cron", expr: "*/15 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "monitor" },
    delivery: { mode: "none" },
    state: { nextRunAtMs },
  };
}

describe("cron scheduled wakes", () => {
  const states: CronServiceState[] = [];

  function createState(
    storePath = "/tmp/test-cron/jobs.json",
    clock = createGatewaySchedulerClock(now),
  ) {
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      scheduler: createTestGatewayScheduler(clock.clock),
      enqueueSystemEvent: vi.fn(),
      runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    states.push(state);
    return state;
  }

  afterEach(() => {
    for (const state of states) {
      stop(state);
    }
    states.length = 0;
  });

  it("joins a scheduled tick waiting for admission without reopening suspension", async ({
    signal,
  }) => {
    const store = await makeStorePath();
    const clock = createGatewaySchedulerClock(now);
    const state = createState(store.storePath, clock);
    state.store = { version: 1, jobs: [job(now + 1_000)] };
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
