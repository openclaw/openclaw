import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { scheduleRestartSentinelWakeAfterReady } from "./server-startup-restart-sentinel.js";

const { scheduleRestartSentinelWake } = vi.hoisted(() => ({
  scheduleRestartSentinelWake:
    vi.fn<typeof import("./server-restart-sentinel.js").scheduleRestartSentinelWake>(),
}));

vi.mock("./server-restart-sentinel.js", () => ({ scheduleRestartSentinelWake }));

beforeEach(() => {
  resetGatewayWorkAdmission();
  scheduleRestartSentinelWake.mockReset();
});
afterEach(resetGatewayWorkAdmission);

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

it.each([
  { awaitingAdmission: false, owner: "sidecar" },
  { awaitingAdmission: true, owner: "sidecar" },
  { awaitingAdmission: false, owner: "scheduler" },
  { awaitingAdmission: true, owner: "scheduler" },
])(
  "cancels delayed restart sentinel recovery when $owner closes (awaiting admission=$awaitingAdmission)",
  async ({ awaitingAdmission, owner }) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const suspension = awaitingAdmission ? tryBeginGatewaySuspendAdmission(() => {}) : null;
    if (awaitingAdmission) {
      expect(suspension?.commit()).toBe(true);
    }
    const sidecar = scheduleRestartSentinelWakeAfterReady({
      scheduler,
      deps: {} as never,
      log: { warn: vi.fn() },
    });
    try {
      const pendingWake = awaitingAdmission ? clock.advanceBy(750) : undefined;
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
