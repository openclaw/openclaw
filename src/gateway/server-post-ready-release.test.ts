import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createPostReadyWorkGate,
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

function scheduleGate(
  profile: "lean" | "standard",
  overrides: { isClosing?: () => boolean; isBusy?: () => boolean } = {},
) {
  const gate = createPostReadyWorkGate();
  const release = vi.fn(gate.release);
  schedulePostReadyWorkRelease({
    scheduler,
    profile,
    release,
    isClosing: overrides.isClosing ?? (() => false),
    isBusy: overrides.isBusy ?? gate.isBusy,
  });
  return { gate, release };
}

it("keeps the standard release 500 ms after startup settles, even while requests run", async () => {
  const request = tryBeginGatewayRootWorkAdmission("test:first-turn");
  const { release } = scheduleGate("standard");
  await clock.advanceBy(499);
  expect(release).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(release).toHaveBeenCalledTimes(1);
  request?.release();
});

it("holds lean post-ready work until an active first turn ends", async () => {
  const turn = tryBeginGatewayRootWorkAdmission("test:first-turn");
  expect(turn).not.toBeNull();
  const { release } = scheduleGate("lean");
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS);
  await clock.advanceBy(LEAN_POST_READY_RETRY_MS * 5);
  expect(release).not.toHaveBeenCalled();
  turn!.release();
  await clock.advanceBy(LEAN_POST_READY_RETRY_MS);
  expect(release).toHaveBeenCalledTimes(1);
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it("does not count roots that are themselves waiting for post-ready work as busy", async () => {
  const { gate, release } = scheduleGate("lean");
  const started = vi.fn();
  // Post-ready maintenance admits its root before it awaits the barrier.
  const maintenance = runWithGatewayIndependentRootWorkAdmission(async () => {
    await gate.wait();
    await gate.wait();
    started();
  }, "runtime:maintenance");
  await Promise.resolve();
  expect(gate.isBusy()).toBe(false);
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS);
  expect(release).toHaveBeenCalledTimes(1);
  await maintenance;
  expect(started).toHaveBeenCalledTimes(1);
  // Once released, the same root is ordinary active work again.
  const turn = tryBeginGatewayRootWorkAdmission("test:later-turn");
  expect(gate.isBusy()).toBe(true);
  turn?.release();
});

it("releases lean post-ready work at the first check when the Gateway is idle", async () => {
  const { release } = scheduleGate("lean");
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS - 1);
  expect(release).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(release).toHaveBeenCalledTimes(1);
});

it("releases lean post-ready work at the cap when the Gateway never goes idle", async () => {
  const { release } = scheduleGate("lean", { isBusy: () => true });
  await clock.advanceBy(LEAN_POST_READY_MAX_DEFER_MS - 1);
  expect(release).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it("stops lean checks once the Gateway closes; close releases the barrier itself", async () => {
  let closing = false;
  const { release } = scheduleGate("lean", { isClosing: () => closing, isBusy: () => true });
  await clock.advanceBy(LEAN_POST_READY_FIRST_CHECK_MS);
  closing = true;
  await clock.advanceBy(LEAN_POST_READY_RETRY_MS);
  expect(release).not.toHaveBeenCalled();
  expect(scheduler.nextWakeAtMs).toBeNull();
});
