import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { waitForMediaCleanupDrainsToSettle } from "./server-media-cleanup-lifecycle.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const { pruneExpiredDeliveryQueueTombstonesMock, pruneOrphanedDeliveryQueueMediaMock } = vi.hoisted(
  () => ({
    pruneExpiredDeliveryQueueTombstonesMock: vi.fn(async () => {}),
    pruneOrphanedDeliveryQueueMediaMock: vi.fn(async () => {}),
  }),
);

vi.mock("../infra/delivery-queue-sqlite.js", async () => {
  const { captureDeliveryQueueStateContext } =
    await import("../infra/delivery-queue-state-context.js");
  return {
    captureDeliveryQueueStateContext,
    pruneExpiredDeliveryQueueTombstones: pruneExpiredDeliveryQueueTombstonesMock,
  };
});
vi.mock("../infra/outbound/delivery-queue-media-spool.js", () => ({
  pruneOrphanedDeliveryQueueMedia: pruneOrphanedDeliveryQueueMediaMock,
}));
// mock-isolation: Delivery cleanup must not start the unrelated device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: vi.fn(async () => 0),
}));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;

function startMaintenance() {
  return startGatewayMaintenanceTimers({
    ...createGatewayMaintenanceStateForTest(),
    scheduler,
    isNixMode: true,
    runDeliveryQueueMediaGc: undefined,
  });
}

async function stopMaintenanceTimers(timers: ReturnType<typeof startMaintenance>) {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

function expectCleanupCalls(count: number) {
  expect(pruneExpiredDeliveryQueueTombstonesMock).toHaveBeenCalledTimes(count);
  expect(pruneOrphanedDeliveryQueueMediaMock).toHaveBeenCalledTimes(count);
}

describe("delivery queue maintenance", () => {
  beforeEach(() => {
    clock = createGatewaySchedulerClock(1_234);
    scheduler = createTestGatewayScheduler(clock.clock);
  });

  afterEach(async () => {
    await scheduler.stop();
    pruneExpiredDeliveryQueueTombstonesMock.mockReset().mockResolvedValue(undefined);
    pruneOrphanedDeliveryQueueMediaMock.mockReset().mockResolvedValue(undefined);
  });

  it("defers tombstone and queue media cleanup through reconnects, then runs hourly", async () => {
    const timers = startMaintenance();
    await waitForMediaCleanupDrainsToSettle();
    await clock.advanceBy(120_000);
    expectCleanupCalls(0);
    await clock.advanceBy(10_000);
    expectCleanupCalls(1);
    await clock.advanceBy(60 * 60_000);
    expectCleanupCalls(2);
    await stopMaintenanceTimers(timers);
  });

  it("joins queue storage and media cleanup before shutdown and rejects later ticks", async () => {
    const expiry = createDeferredCore();
    const media = createDeferredCore();
    pruneExpiredDeliveryQueueTombstonesMock.mockReturnValueOnce(expiry.promise);
    pruneOrphanedDeliveryQueueMediaMock.mockReturnValueOnce(media.promise);
    const timers = startMaintenance();
    let stopped = false;
    await waitForMediaCleanupDrainsToSettle();
    void clock.advanceBy(130_000);
    const stopping = timers.stopMediaCleanup().then((result) => {
      stopped = true;
      return result;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(pruneOrphanedDeliveryQueueMediaMock).not.toHaveBeenCalled();
      expiry.resolve();
      await Promise.resolve();
      expect(pruneOrphanedDeliveryQueueMediaMock).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
      media.resolve();
      await expect(stopping).resolves.toBe("drained");
      await clock.advanceBy(60 * 60_000);
      expectCleanupCalls(1);
    } finally {
      expiry.resolve();
      media.resolve();
      await stopping;
      await stopMaintenanceTimers(timers);
    }
  });
});
