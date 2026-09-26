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
import { createCronServiceState, type CronServiceState } from "./service/state.js";
import { armTimer } from "./service/timer.js";
import { onTimer } from "./service/timer.test-support.js";
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
      requestHeartbeat: vi.fn(),
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

  it("replaces the scheduled wake when an earlier occurrence appears", () => {
    const state = createState();
    state.store = { version: 1, jobs: [job(now + 30_000)] };
    armTimer(state);
    const replaced = state.timer;
    expect(state.deps.scheduler.nextWakeAtMs).toBe(now + 30_000);

    state.store.jobs[0]!.state.nextRunAtMs = now + 10_000;
    armTimer(state);
    replaced?.cancel();

    expect(state.deps.scheduler.nextWakeAtMs).toBe(now + 10_000);
    stop(state);
    expect(state.deps.scheduler.nextWakeAtMs).toBeNull();
  });

  it("keeps a maintenance wake when enabled jobs have no next occurrence", () => {
    const state = createState();
    const unscheduled = job();
    state.store = { version: 1, jobs: [unscheduled] };

    armTimer(state);

    expect(state.deps.scheduler.nextWakeAtMs).toBe(now + 60_000);
    expect(unscheduled.state.nextRunAtMs).toBeUndefined();
  });

  it("joins a scheduled tick waiting for admission without reopening suspension", async ({
    signal,
  }) => {
    const clock = createGatewaySchedulerClock(now);
    const state = createState(undefined, clock);
    state.store = { version: 1, jobs: [job(now + 1_000)] };
    armTimer(state);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const releaseSuspension = () => {
      suspension?.release();
    };
    signal.addEventListener("abort", releaseSuspension, { once: true });
    const wake = clock.advanceBy(1_000);

    try {
      state.deps.scheduler.beginClose();
      stop(state);
      await state.deps.scheduler.stop();
      await wake;

      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(state.storeLoadedAtMs).toBeNull();
      expect(state.deps.log.error).not.toHaveBeenCalled();
    } finally {
      signal.removeEventListener("abort", releaseSuspension);
      releaseSuspension();
      await wake;
    }
  });

  it("rechecks after clock rollback without executing a future stored occurrence", async () => {
    const store = await makeStorePath();
    const nextRunAtMs = now + 10 * 60_000;
    const future = {
      ...job(nextRunAtMs),
      schedule: { kind: "every" as const, everyMs: 10 * 60_000, anchorMs: now },
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [future] });
    const clock = createGatewaySchedulerClock(now);
    const state = createState(store.storePath, clock);
    state.store = { version: 1, jobs: [future] };
    armTimer(state);

    clock.setTime(now - 60 * 60_000);
    await clock.advanceBy(60_000);

    expect(state.storeLoadedAtMs).toBe(clock.clock.now());
    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(state.deps.scheduler.nextWakeAtMs).toBe(clock.clock.now() + 60_000);

    clock.setTime(nextRunAtMs);
    await clock.advanceBy(60_000);

    expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledOnce();
  });

  it("keeps a past-due active occurrence from producing a zero-delay loop", async () => {
    const store = await makeStorePath();
    const overdue = job(now - 17 * 60_000);
    overdue.state.runningAtMs = overdue.state.nextRunAtMs! + 1;
    await saveCronStore(store.storePath, { version: 1, jobs: [overdue] });
    const state = createState(store.storePath);

    await onTimer(state);

    expect(state.running).toBe(false);
    expect(state.deps.scheduler.nextWakeAtMs).toBeGreaterThanOrEqual(now + 2_000);
  });
});
