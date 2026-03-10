import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { resolveMessageChannelSelection } from "./channel-selection.js";

function makePlugin(id: string, opts?: { isConfigured?: boolean }) {
  return {
    id,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isConfigured: async () => opts?.isConfigured ?? true,
    },
  };
}

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
  });

  it("keeps explicit known channels and marks source explicit", async () => {
    mocks.listChannelPlugins.mockReturnValue([makePlugin("telegram")]);

    const selection = await resolveMessageChannelSelection({
      cfg: { channels: { telegram: { accounts: { default: {} } } } } as never,
      channel: "telegram",
    });

    expect(selection).toEqual({
      channel: "telegram",
      configured: ["telegram"],
      source: "explicit",
    });
  });

  it("throws for known-but-unconfigured explicit channel even when fallback exists", async () => {
    mocks.listChannelPlugins.mockReturnValue([makePlugin("telegram")]);

    // Explicit channel must not silently reroute — the agent should see the
    // error and retry with a valid channel to avoid misdelivery.
    await expect(
      resolveMessageChannelSelection({
        cfg: { channels: { telegram: { accounts: { default: {} } } } } as never,
        channel: "whatsapp",
        fallbackChannel: "telegram",
      }),
    ).rejects.toThrow("Channel whatsapp is not configured. Configured channels: telegram");
  });

  it("throws for known-but-unconfigured channel when no channels configured at all", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "whatsapp",
      }),
    ).rejects.toThrow(
      "Channel whatsapp is not configured (no message channels are configured).",
    );
  });

  it("falls back to tool context channel when explicit channel is unknown", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "channel:C123",
      fallbackChannel: "slack",
    });

    expect(selection).toEqual({
      channel: "slack",
      configured: [],
      source: "tool-context-fallback",
    });
  });

  it("uses fallback channel when explicit channel is omitted", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      fallbackChannel: "signal",
    });

    expect(selection).toEqual({
      channel: "signal",
      configured: [],
      source: "tool-context-fallback",
    });
  });

  it("selects single configured channel when no explicit/fallback channel exists", async () => {
    mocks.listChannelPlugins.mockReturnValue([makePlugin("discord")]);

    const selection = await resolveMessageChannelSelection({
      cfg: { channels: { discord: { accounts: { default: {} } } } } as never,
    });

    expect(selection).toEqual({
      channel: "discord",
      configured: ["discord"],
      source: "single-configured",
    });
  });

  it("excludes unconfigured channels from configured list", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin("discord"),
      makePlugin("whatsapp", { isConfigured: true }),
    ]);

    // Only discord has a config block; whatsapp has no config entry
    // so isPluginConfigured skips it despite isConfigured returning true.
    const selection = await resolveMessageChannelSelection({
      cfg: { channels: { discord: { accounts: { default: {} } } } } as never,
    });

    expect(selection).toEqual({
      channel: "discord",
      configured: ["discord"],
      source: "single-configured",
    });
  });

  it("throws unknown channel when explicit and fallback channels are both invalid", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "channel:C123",
        fallbackChannel: "not-a-channel",
      }),
    ).rejects.toThrow("Unknown channel: channel:c123");
  });
});
