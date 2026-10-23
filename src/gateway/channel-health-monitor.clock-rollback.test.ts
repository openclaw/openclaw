import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { createMockChannelManager } from "./channel-health-monitor.test-support.js";
import type { ChannelManager } from "./server-channels.js";

const STARTED_AT = 1_000_000;
const CHECK_INTERVAL_MS = 5 * 60_000;
const STARTUP_GRACE_MS = 60_000;

function createChannelManager(running: boolean) {
  const account: ChannelAccountSnapshot = {
    accountId: "default",
    running,
    connected: running,
    enabled: true,
    configured: true,
  };
  const snapshot = {
    channels: { discord: account },
    channelAccounts: { discord: { default: account } },
  };
  const manager: ChannelManager = createMockChannelManager({
    getRuntimeSnapshot: vi.fn(() => snapshot),
  });
  return { account, manager };
}

describe("channel-health-monitor clock rollback", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: GatewayScheduler;
  beforeEach(() => {
    clock = createGatewaySchedulerClock(STARTED_AT);
    scheduler = createTestGatewayScheduler(clock.clock);
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  it("does not trap an existing monitor in startup grace after clock rollback", async () => {
    const { manager } = createChannelManager(false);
    const monitor = startChannelHealthMonitor({
      scheduler,
      channelManager: manager,
    });

    clock.setTime(STARTED_AT - 60_000);
    await clock.wake();

    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default", {
      reason: "health-monitor",
    });
    monitor.stop();
  });

  it("discards a future restart cooldown from an existing monitor", async () => {
    const { account, manager } = createChannelManager(true);
    const monitor = startChannelHealthMonitor({
      scheduler,
      channelManager: manager,
    });

    await clock.advanceBy(STARTUP_GRACE_MS);
    account.running = false;
    account.connected = false;
    await clock.advanceBy(CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);

    clock.setTime(STARTED_AT + STARTUP_GRACE_MS);
    await clock.wake();

    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
