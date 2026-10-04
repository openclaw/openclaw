import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  refreshLatestUpdateRestartSentinelIfPresent,
  scheduleRestartSentinelWakeAfterReady,
} from "./server-startup-restart-sentinel.js";

const { refreshLatestUpdateRestartSentinel, scheduleRestartSentinelWake } = vi.hoisted(() => ({
  refreshLatestUpdateRestartSentinel:
    vi.fn<typeof import("./server-restart-sentinel.js").refreshLatestUpdateRestartSentinel>(),
  scheduleRestartSentinelWake:
    vi.fn<typeof import("./server-restart-sentinel.js").scheduleRestartSentinelWake>(),
}));

vi.mock("./server-restart-sentinel.js", () => ({
  refreshLatestUpdateRestartSentinel,
  scheduleRestartSentinelWake,
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

beforeEach(() => {
  resetGatewayWorkAdmission();
  refreshLatestUpdateRestartSentinel.mockReset();
  scheduleRestartSentinelWake.mockReset();
});
afterEach(resetGatewayWorkAdmission);

it("refreshes only an existing restart sentinel", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("restart-sentinel-startup-") };
  await expect(refreshLatestUpdateRestartSentinelIfPresent(env)).resolves.toBeNull();
  expect(refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();

  const sentinel = { kind: "update", status: "ok", ts: 1 } as const;
  await writeRestartSentinel(sentinel, env);
  refreshLatestUpdateRestartSentinel.mockResolvedValue(sentinel);
  await expect(refreshLatestUpdateRestartSentinelIfPresent(env)).resolves.toBe(sentinel);
  expect(refreshLatestUpdateRestartSentinel).toHaveBeenCalledExactlyOnceWith(env);
});

it("keeps delayed restart sentinel recovery admitted until wake work completes", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const { promise: wake, resolve: finishWake } = createDeferred();
  const started = createDeferred();
  scheduleRestartSentinelWake.mockImplementationOnce(() => {
    started.resolve();
    return wake;
  });

  const sidecar = scheduleRestartSentinelWakeAfterReady({
    scheduler,
    deps: {} as never,
    log: { warn: vi.fn() },
  });
  const pendingWake = clock.advanceBy(750);
  await started.promise;

  expect(scheduleRestartSentinelWake).toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(1);

  finishWake?.();
  await pendingWake;
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  await sidecar.stop();
});

it.each(["sidecar", "scheduler"] as const)(
  "cancels restart sentinel recovery awaiting admission when %s closes",
  async (owner) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const sidecar = scheduleRestartSentinelWakeAfterReady({
      scheduler,
      deps: {} as never,
      log: { warn: vi.fn() },
    });
    try {
      const pendingWake = clock.advanceBy(750);
      await (owner === "scheduler" ? scheduler.stop() : sidecar.stop());
      await pendingWake;
      await clock.advanceBy(750);
      expect(scheduleRestartSentinelWake).not.toHaveBeenCalled();
    } finally {
      suspension?.release();
      await sidecar.stop();
    }
  },
);
