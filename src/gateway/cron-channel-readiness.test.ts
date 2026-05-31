import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { waitForConfiguredChannelDeliveryReadiness } from "./cron-channel-readiness.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";

describe("waitForConfiguredChannelDeliveryReadiness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when configured channel accounts are connected", async () => {
    const log = { warn: vi.fn() };

    await waitForConfiguredChannelDeliveryReadiness({
      getRuntimeSnapshot: () =>
        createRuntimeSnapshot({
          discord: {
            default: {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
            },
          },
        }),
      timeoutMs: 10,
      pollIntervalMs: 1,
      log,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("waits until a configured channel account reports connected", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };
    let connected = false;

    const wait = waitForConfiguredChannelDeliveryReadiness({
      getRuntimeSnapshot: () =>
        createRuntimeSnapshot({
          discord: {
            default: {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected,
            },
          },
        }),
      timeoutMs: 50,
      pollIntervalMs: 5,
      log,
    });

    await vi.advanceTimersByTimeAsync(5);
    connected = true;
    await vi.advanceTimersByTimeAsync(5);
    await wait;

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns once and proceeds when configured channel accounts stay unconnected", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };

    const wait = waitForConfiguredChannelDeliveryReadiness({
      getRuntimeSnapshot: () =>
        createRuntimeSnapshot({
          discord: {
            default: {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: false,
            },
          },
        }),
      timeoutMs: 10,
      pollIntervalMs: 5,
      log,
    });

    await vi.advanceTimersByTimeAsync(10);
    await wait;

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      "gateway cron starting before channel delivery readiness; unconnected channel accounts: discord/default",
    );
  });

  it("skips unmanaged accounts and accounts without active transport readiness", async () => {
    const log = { warn: vi.fn() };

    await waitForConfiguredChannelDeliveryReadiness({
      getRuntimeSnapshot: () =>
        createRuntimeSnapshot({
          discord: {
            disabled: { accountId: "disabled", enabled: false, configured: true, connected: false },
            stopped: {
              accountId: "stopped",
              enabled: true,
              configured: true,
              running: false,
              connected: false,
            },
            unconfigured: {
              accountId: "unconfigured",
              enabled: true,
              configured: false,
              connected: false,
            },
          },
          slack: {
            default: { accountId: "default", enabled: true, configured: true },
          },
        }),
      timeoutMs: 10,
      pollIntervalMs: 1,
      log,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("aborts waiting when the gateway is closing", async () => {
    const log = { warn: vi.fn() };

    await waitForConfiguredChannelDeliveryReadiness({
      getRuntimeSnapshot: () =>
        createRuntimeSnapshot({
          discord: {
            default: {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: false,
            },
          },
        }),
      timeoutMs: 10,
      pollIntervalMs: 1,
      isClosing: () => true,
      log,
    });

    expect(log.warn).not.toHaveBeenCalled();
  });
});

function createRuntimeSnapshot(
  channelAccounts: Partial<Record<string, Record<string, ChannelAccountSnapshot>>>,
): ChannelRuntimeSnapshot {
  return {
    channels: {},
    channelAccounts: channelAccounts as ChannelRuntimeSnapshot["channelAccounts"],
  };
}
