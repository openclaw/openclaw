import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { waitForMediaCleanupDrainsToSettle } from "./server-media-cleanup-lifecycle.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const cleanup = vi.hoisted(() => ({
  tombstones: vi.fn(async () => {}),
  media: vi.fn(async () => {}),
}));

vi.mock("../infra/delivery-queue-sqlite.js", async () => {
  const { captureDeliveryQueueStateContext } =
    await import("../infra/delivery-queue-state-context.js");
  return {
    captureDeliveryQueueStateContext,
    pruneExpiredDeliveryQueueTombstones: cleanup.tombstones,
  };
});
vi.mock("../infra/outbound/delivery-queue-media-spool.js", () => ({
  pruneOrphanedDeliveryQueueMedia: cleanup.media,
}));
// mock-isolation: Delivery cleanup must not start the unrelated device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: vi.fn(async () => 0),
}));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let timers: ReturnType<typeof startGatewayMaintenanceTimers>;
const releaseHolds: (() => void)[] = [];

beforeEach(() => {
  clock = createGatewaySchedulerClock(1_234);
  timers = startGatewayMaintenanceTimers({
    ...createGatewayMaintenanceStateForTest(),
    scheduler: createTestGatewayScheduler(clock.clock),
    isNixMode: true,
    runDeliveryQueueMediaGc: undefined,
  });
});

afterEach(async () => {
  releaseHolds.splice(0).forEach((release) => release());
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
  cleanup.tombstones.mockReset().mockResolvedValue(undefined);
  cleanup.media.mockReset().mockResolvedValue(undefined);
});

function expectCleanupCalls(count: number) {
  expect(cleanup.tombstones).toHaveBeenCalledTimes(count);
  expect(cleanup.media).toHaveBeenCalledTimes(count);
}

it("defers tombstone and queue media cleanup through reconnects, then runs hourly", async () => {
  await waitForMediaCleanupDrainsToSettle();
  await clock.advanceBy(120_000);
  expectCleanupCalls(0);
  await clock.advanceBy(10_000);
  expectCleanupCalls(1);
  await clock.advanceBy(60 * 60_000);
  expectCleanupCalls(2);
});

it("joins queue storage and media cleanup before shutdown and rejects later ticks", async () => {
  const expiry = createDeferredCore();
  const media = createDeferredCore();
  releaseHolds.push(expiry.resolve, media.resolve);
  cleanup.tombstones.mockReturnValueOnce(expiry.promise);
  cleanup.media.mockReturnValueOnce(media.promise);
  let stopped = false;
  await waitForMediaCleanupDrainsToSettle();
  void clock.advanceBy(130_000);
  const stopping = timers.stopMediaCleanup().then((result) => {
    stopped = true;
    return result;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(cleanup.media).not.toHaveBeenCalled();
  expiry.resolve();
  await Promise.resolve();
  expect(cleanup.media).toHaveBeenCalledOnce();
  expect(stopped).toBe(false);
  media.resolve();
  await expect(stopping).resolves.toBe("drained");
  await clock.advanceBy(60 * 60_000);
  expectCleanupCalls(1);
});
