import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { ChannelManager } from "./server-channels.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  type TestAccount,
} from "./server-channels.test-support.js";

describe("channel stop-timeout recovery", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  function account(manager: ChannelManager, accountId = DEFAULT_ACCOUNT_ID) {
    return manager.getRuntimeSnapshot().channelAccounts.discord?.[accountId];
  }

  it("recovers a manual stop that timed out against an abort-ignoring task", async () => {
    const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContextV2<TestAccount>) => {
      if (startAccount.mock.calls.length === 1) {
        await new Promise<void>(() => {});
        return;
      }
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const registry = createTestChannelRegistry(createTestPlugin({ startAccount }));
    const manager = createTestChannelManager({ getPluginRegistry: () => registry });
    try {
      await manager.startChannels();
      const stop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      await vi.advanceTimersByTimeAsync(5_000);
      await stop;

      expect(startAccount).toHaveBeenCalledTimes(1);
      expect(account(manager)).toMatchObject({
        running: true,
        restartPending: false,
        lastError: "channel stop timed out after 5000ms",
      });

      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      expect(startAccount).toHaveBeenCalledTimes(2);
      expect(account(manager)).toMatchObject({ running: true, restartPending: false });
    } finally {
      const cleanup = manager.stopChannel("discord").catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
      await cleanup;
    }
  });
});
