import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";

// Verify that buildChannelSummary resolves plugins with includeSetupFallbackPlugins: true
// so that setup-path channels (e.g. Telegram) appear in `openclaw status --json` channelSummary.
// Regression: previously used false, causing channelSummary to return [] for Telegram (#79797).

const listReadOnlyChannelPluginsForConfig = vi.hoisted(() => vi.fn(() => [] as ChannelPlugin[]));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(async () => ({ channels: {} })),
}));

describe("buildChannelSummary plugin resolution", () => {
  it("resolves plugins with includeSetupFallbackPlugins: true when no plugins are supplied", async () => {
    const { buildChannelSummary } = await import("./channel-summary.js");
    await buildChannelSummary({ channels: {} } as never);

    const calls = listReadOnlyChannelPluginsForConfig.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const options = (calls[0] as unknown as unknown[])?.[1] as
      | { includeSetupFallbackPlugins?: boolean }
      | undefined;
    expect(options?.includeSetupFallbackPlugins).toBe(true);
  });
});
