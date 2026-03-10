import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";

function makePlugin(params: {
  id: string;
  accountIds?: string[];
  resolveAccount?: (accountId: string) => unknown;
  isEnabled?: (account: unknown) => boolean;
  isConfigured?: (account: unknown) => boolean | Promise<boolean>;
}) {
  return {
    id: params.id,
    config: {
      listAccountIds: () => params.accountIds ?? ["default"],
      resolveAccount: (_cfg: unknown, accountId: string) =>
        params.resolveAccount ? params.resolveAccount(accountId) : {},
      ...(params.isEnabled ? { isEnabled: params.isEnabled } : {}),
      ...(params.isConfigured ? { isConfigured: params.isConfigured } : {}),
    },
  };
}

describe("listConfiguredMessageChannels", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
  });

  it("skips unknown plugin ids and plugins without accounts", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin({ id: "not-a-channel" }),
      makePlugin({ id: "slack", accountIds: [] }),
    ]);

    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual([]);
  });

  it("includes plugins without isConfigured when an enabled account exists", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin({
        id: "discord",
        resolveAccount: () => ({ enabled: true }),
      }),
    ]);

    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual(["discord"]);
  });

  it("skips disabled accounts and keeps later configured accounts", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin({
        id: "telegram",
        accountIds: ["disabled", "enabled"],
        resolveAccount: (accountId) =>
          accountId === "disabled" ? { enabled: false } : { enabled: true },
        isConfigured: (account) => (account as { enabled?: boolean }).enabled === true,
      }),
    ]);

    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual(["telegram"]);
  });

  it("respects custom isEnabled checks", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin({
        id: "signal",
        resolveAccount: () => ({ token: "x" }),
        isEnabled: () => false,
        isConfigured: () => true,
      }),
    ]);

    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual([]);
  });
});

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
  });

  it("keeps explicit known channels and marks source explicit", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "telegram",
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

    expect(selection).toEqual({
      channel: "telegram",
      configured: ["telegram"],
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
      makePlugin({ id: "discord", isConfigured: async () => true }),
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

  it("falls back when the explicit known channel is unavailable in the active plugin registry", async () => {
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) =>
      channel === "slack" ? { id: "slack" } : undefined,
    );

    const selection = await resolveMessageChannelSelection({
      cfg: {} as never,
      channel: "discord",
      fallbackChannel: "slack",
    });

    expect(selection).toEqual({
      channel: "slack",
      configured: [],
      source: "tool-context-fallback",
    });
  });

  it("throws unavailable when a known channel has no active plugin", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);

    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "discord",
      }),
    ).rejects.toThrow("Channel is unavailable: discord");
  });

  it("throws when no channel is provided and nothing is configured", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
      }),
    ).rejects.toThrow("Channel is required (no configured channels detected).");
  });

  it("throws when multiple channels are configured and no channel is selected", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin({ id: "discord", isConfigured: async () => true }),
      makePlugin({ id: "telegram", isConfigured: async () => true }),
    ]);

    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
      }),
    ).rejects.toThrow(
      "Channel is required when multiple channels are configured: discord, telegram",
    );
  });

  it("throws when explicit channel is known but not configured (#42080)", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "whatsapp",
      }),
    ).rejects.toThrow('Channel "whatsapp" is not configured.');
  });

  it("falls back to context channel when explicit channel is unconfigured (#42080)", async () => {
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
      channel: "whatsapp",
      fallbackChannel: "discord",
    });

    expect(selection).toEqual({
      channel: "discord",
      configured: ["discord"],
      source: "tool-context-fallback",
    });
  });

  it("includes configured channels hint in unconfigured channel error (#42080)", async () => {
    mocks.listChannelPlugins.mockReturnValue([
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
        channel: "whatsapp",
      }),
    ).rejects.toThrow('Channel "whatsapp" is not configured. Configured channels: telegram.');
  });
});
