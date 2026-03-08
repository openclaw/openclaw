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

  it("normalizes explicit channel (case-insensitive)", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "Telegram",
    });

    expect(selection).toEqual({
      channel: "telegram",
      configured: [],
      source: "explicit",
    });
  });

  it("throws when fallback is disabled and no channel provided", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {
          tools: { message: { fallbackChannel: { enabled: false } } },
        } as never,
      }),
    ).rejects.toThrow(/Unknown channel/);
  });

  it("throws when fallback is disabled and explicit channel is unknown", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {
          tools: { message: { fallbackChannel: { enabled: false } } },
        } as never,
        channel: "channel:C123",
        fallbackChannel: "slack",
      }),
    ).rejects.toThrow("Unknown channel: channel:c123");
  });

  it("throws when no channel/fallback and zero configured channels", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
      }),
    ).rejects.toThrow("Channel is required (no configured channels detected).");
  });

  it("throws when no channel/fallback and multiple channels configured", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "discord",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      },
      {
        id: "telegram",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      },
    ]);

    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
      }),
    ).rejects.toThrow(/Channel is required when multiple channels are configured/);
  });

  it("uses fallback when channel omitted and fallback valid (no configured list needed)", async () => {
    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      fallbackChannel: "discord",
    });

    expect(selection.source).toBe("tool-context-fallback");
    expect(selection.channel).toBe("discord");
  });

  it("returns configured list when explicit channel is used", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "slack",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      },
    ]);

    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "telegram",
    });

    expect(selection.source).toBe("explicit");
    expect(selection.channel).toBe("telegram");
    expect(selection.configured).toContain("slack");
  });
});
