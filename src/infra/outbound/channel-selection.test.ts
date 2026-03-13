import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
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
});
