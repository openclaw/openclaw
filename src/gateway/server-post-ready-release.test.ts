import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  LEAN_POST_READY_FIRST_CHECK_MS,
  LEAN_POST_READY_MAX_DEFER_MS,
  LEAN_POST_READY_RETRY_MS,
  schedulePostReadyWorkRelease,
} from "./server-post-ready-release.js";

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;
beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
});

afterEach(async () => {
  await scheduler.stop();
  resetGatewayWorkAdmission();
});

it("keeps the standard release 500 ms after startup settles, even while requests run", async () => {
  const release = vi.fn();
  const request = tryBeginGatewayRootWorkAdmission("test:first-turn");
  schedulePostReadyWorkRelease({
    scheduler,
    profile: "standard",
    release,
    isClosing: () => false,
  });
  await clock.advanceBy(499);
  expect(release).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(release).toHaveBeenCalledTimes(1);
  request?.release();
});

it("holds lean post-ready work until an active first turn ends", async () => {
  const release = vi.fn();
  const turn = tryBeginGatewayRootWorkAdmission("test:first-turn");
  expect(turn).not.toBeNull();
  schedulePostReadyWorkRelease({ scheduler, profile: "lean", release, isClosing: () => false });
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS);
  await clock.advanceBy(LEAN_POST_READY_RETRY_MS * 5);
  expect(release).not.toHaveBeenCalled();
  turn!.release();
  await clock.advanceBy(LEAN_POST_READY_RETRY_MS);
  expect(release).toHaveBeenCalledTimes(1);
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it("releases lean post-ready work at the first check when the Gateway is idle", async () => {
  const release = vi.fn();
  schedulePostReadyWorkRelease({ scheduler, profile: "lean", release, isClosing: () => false });
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS - 1);
  expect(release).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(release).toHaveBeenCalledTimes(1);
});

it("releases lean post-ready work at the cap when the Gateway never goes idle", async () => {
  const release = vi.fn();
  schedulePostReadyWorkRelease({
    scheduler,
    profile: "lean",
    release,
    isClosing: () => false,
    isBusy: () => true,
  });
  await clock.advanceBy(LEAN_POST_READY_MAX_DEFER_MS - 1);
  expect(release).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it("stops lean checks once the Gateway closes; close releases the barrier itself", async () => {
  const release = vi.fn();
  let closing = false;
  schedulePostReadyWorkRelease({
    scheduler,
    profile: "lean",
    release,
    isClosing: () => closing,
    isBusy: () => true,
  });
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS);
  closing = true;
  await clock.advanceBy(LEAN_POST_READY_RETRY_MS);
  expect(release).not.toHaveBeenCalled();
  expect(scheduler.nextWakeAtMs).toBeNull();
});
