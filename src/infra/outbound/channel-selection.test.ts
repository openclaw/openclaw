import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { resolveMessageChannelSelection } from "./channel-selection.js";

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
  });

  it("keeps explicit known channels and marks source explicit", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "telegram",
    });

    expect(selection).toEqual({
      channel: "telegram",
      configured: [],
      source: "explicit",
    });
  });

  it("accepts provider-prefixed channel values for explicit cross-channel routing", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "discord:123456789012345678",
    });

    expect(selection).toEqual({
      channel: "discord",
      configured: [],
      source: "explicit",
    });
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
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "discord",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      },
    ]);

    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
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
