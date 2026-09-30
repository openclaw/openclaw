import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
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
vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: vi.fn(async () => 0),
}));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    scheduler,
    isNixMode: true,
    runWorktreeGc: vi.fn(async () => undefined),
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
  };
}

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
) {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

describe("delivery queue maintenance", () => {
  beforeEach(() => {
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
  });

  afterEach(async () => {
    await scheduler.stop();
    pruneExpiredDeliveryQueueTombstonesMock.mockReset().mockResolvedValue(undefined);
    pruneOrphanedDeliveryQueueMediaMock.mockReset().mockResolvedValue(undefined);
  });

  it("runs queue media cleanup at startup and hourly", async () => {
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);

    await waitForMediaCleanupDrainsToSettle();
    await clock.advanceBy(0);
    expect(deps.runDeliveryQueueMediaGc).toHaveBeenCalledTimes(1);
    await clock.advanceBy(60 * 60_000);
    expect(deps.runDeliveryQueueMediaGc).toHaveBeenCalledTimes(2);
    expect(pruneExpiredDeliveryQueueTombstonesMock).not.toHaveBeenCalled();

    await stopMaintenanceTimers(timers);
  });

  it("runs tombstone expiry with default queue media cleanup at startup and hourly", async () => {
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const { runDeliveryQueueMediaGc: _runDeliveryQueueMediaGc, ...deps } =
      createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);

    await waitForMediaCleanupDrainsToSettle();
    await clock.advanceBy(0);
    expect(pruneExpiredDeliveryQueueTombstonesMock).toHaveBeenCalledTimes(1);
    expect(pruneOrphanedDeliveryQueueMediaMock).toHaveBeenCalledTimes(1);
    await clock.advanceBy(60 * 60_000);
    expect(pruneExpiredDeliveryQueueTombstonesMock).toHaveBeenCalledTimes(2);
    expect(pruneOrphanedDeliveryQueueMediaMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("joins queue storage and media cleanup before shutdown and rejects later ticks", async () => {
    const expiry = createDeferredCore();
    const media = createDeferredCore();
    pruneExpiredDeliveryQueueTombstonesMock.mockReturnValueOnce(expiry.promise);
    pruneOrphanedDeliveryQueueMediaMock.mockReturnValueOnce(media.promise);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const { runDeliveryQueueMediaGc: _runDeliveryQueueMediaGc, ...deps } =
      createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);
    let stopped = false;
    await waitForMediaCleanupDrainsToSettle();
    void clock.advanceBy(0);
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
      expect(pruneExpiredDeliveryQueueTombstonesMock).toHaveBeenCalledOnce();
      expect(pruneOrphanedDeliveryQueueMediaMock).toHaveBeenCalledOnce();
    } finally {
      expiry.resolve();
      media.resolve();
      await stopping;
      await stopMaintenanceTimers(timers);
    }
  });
});
