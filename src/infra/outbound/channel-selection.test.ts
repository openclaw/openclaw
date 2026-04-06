import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

type ChannelSelectionModule = typeof import("./channel-selection.js");
type RuntimeModule = typeof import("../../runtime.js");

let __testing: ChannelSelectionModule["__testing"];
let listConfiguredMessageChannels: ChannelSelectionModule["listConfiguredMessageChannels"];
let resolveMessageChannelSelection: ChannelSelectionModule["resolveMessageChannelSelection"];
let runtimeModule: RuntimeModule;

beforeAll(async () => {
  runtimeModule = await import("../../runtime.js");
  ({ __testing, listConfiguredMessageChannels, resolveMessageChannelSelection } =
    await import("./channel-selection.js"));
});

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

async function expectResolvedSelection(
  params: Parameters<typeof resolveMessageChannelSelection>[0],
): Promise<Awaited<ReturnType<typeof resolveMessageChannelSelection>>> {
  return await resolveMessageChannelSelection(params);
}

describe("listConfiguredMessageChannels", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(runtimeModule.defaultRuntime, "error").mockImplementation(() => undefined);
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
    __testing.resetLoggedChannelSelectionErrors();
    errorSpy.mockClear();
  });

  it.each([
    {
      plugins: [makePlugin({ id: "not-a-channel" }), makePlugin({ id: "slack", accountIds: [] })],
      expected: [],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "discord",
          resolveAccount: () => ({ enabled: true }),
        }),
      ],
      expected: ["discord"],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "telegram",
          accountIds: ["disabled", "enabled"],
          resolveAccount: (accountId) =>
            accountId === "disabled" ? { enabled: false } : { enabled: true },
          isConfigured: (account) => (account as { enabled?: boolean }).enabled === true,
        }),
      ],
      expected: ["telegram"],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "signal",
          resolveAccount: () => ({ token: "x" }),
          isEnabled: () => false,
          isConfigured: () => true,
        }),
      ],
      expected: [],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "discord",
          resolveAccount: () => {
            throw new Error("boom");
          },
        }),
      ],
      expected: [],
      expectedErrors: 1,
    },
  ])("lists configured channels for %j", async ({ plugins, expected, expectedErrors }) => {
    mocks.listChannelPlugins.mockReturnValue(plugins);
    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual(expected);
    expect(errorSpy).toHaveBeenCalledTimes(expectedErrors);
  });
});

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
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

  it("does not fall back when an explicit channel looks like a target id", async () => {
    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "1475627489236881568",
        fallbackChannel: "discord",
      }),
    ).rejects.toThrow(/Use `target` for channel\/user\/thread ids or names/);
  });

  it("does not fall back when an explicit channel is unavailable", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);

    await expect(
      resolveMessageChannelSelection({
        cfg: {} as never,
        channel: "discord",
        fallbackChannel: "slack",
      }),
    ).rejects.toThrow("Channel is unavailable: discord");
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

  it.each([
    {
      params: { cfg: {} as never, channel: "not-a-channel" },
      expectedMessage: "Unknown channel provider: not-a-channel",
    },
    {
      params: { cfg: {} as never },
      expectedMessage: "Channel is required (no configured channels detected).",
    },
    {
      setup: () => {
        mocks.listChannelPlugins.mockReturnValue([
          makePlugin({ id: "discord", isConfigured: async () => true }),
          makePlugin({ id: "telegram", isConfigured: async () => true }),
        ]);
      },
      params: { cfg: {} as never },
      expectedMessage:
        "Channel is required when multiple channels are configured: discord, telegram",
    },
  ])("rejects invalid channel selection for %j", async ({ setup, params, expectedMessage }) => {
    setup?.();
    await expect(expectResolvedSelection(params)).rejects.toThrow(expectedMessage);
  });
});
