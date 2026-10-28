// Covers message channel selection from explicit input, tool context fallback,
// configured accounts, and missing official external plugin repair hints.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  listRuntimeVisibleChannelPlugins: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
  missingOfficialExternalChannels: new Set<string>(),
  scopedRegistryChannelIds: new Set<string>(),
}));

const deliverableChannelIds = vi.hoisted(() => [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "feishu",
  "muted",
  "whatsapp",
]);

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: vi.fn(),
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../utils/message-channel.js", () => ({
  listDeliverableMessageChannels: () => deliverableChannelIds,
  isDeliverableMessageChannel: (value: string) => deliverableChannelIds.includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return normalized && deliverableChannelIds.includes(normalized) ? normalized : undefined;
  },
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./runtime-visible-channels.js", () => ({
  // Defaults to the process-root list; scoped-registry tests override it.
  listRuntimeVisibleChannelPlugins: (...args: unknown[]) =>
    mocks.listRuntimeVisibleChannelPlugins(...args) ?? mocks.listChannelPlugins(...args),
  getRuntimeVisibleChannelPlugin: (channel: string) =>
    mocks.scopedRegistryChannelIds.has(channel) ? { id: channel } : undefined,
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint: ({ channelId }: { channelId: string }) =>
    mocks.missingOfficialExternalChannels.has(channelId)
      ? {
          pluginId: channelId,
          channelId,
          label: channelId === "whatsapp" ? "WhatsApp" : "Feishu",
          installSpec: `@openclaw/${channelId}`,
          installCommand: `openclaw plugins install @openclaw/${channelId}`,
          doctorFixCommand: "openclaw doctor --fix",
          repairHint: `Install the official external plugin with: openclaw plugins install @openclaw/${channelId}, or run: openclaw doctor --fix.`,
        }
      : null,
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) =>
    channelIds.flatMap((channelId) =>
      mocks.missingOfficialExternalChannels.has(channelId)
        ? [
            {
              pluginId: channelId,
              channelId,
              label: channelId === "whatsapp" ? "WhatsApp" : "Feishu",
              installSpec: `@openclaw/${channelId}`,
              installCommand: `openclaw plugins install @openclaw/${channelId}`,
              doctorFixCommand: "openclaw doctor --fix",
              repairHint: `Install the official external plugin with: openclaw plugins install @openclaw/${channelId}, or run: openclaw doctor --fix.`,
            },
          ]
        : [],
    ),
}));

type ChannelSelectionModule = typeof import("./channel-selection.js");

let listConfiguredMessageChannels: ChannelSelectionModule["listConfiguredMessageChannels"];
let resolveMessageChannelSelection: ChannelSelectionModule["resolveMessageChannelSelection"];

beforeAll(async () => {
  ({ listConfiguredMessageChannels, resolveMessageChannelSelection } =
    await import("./channel-selection.js"));
});

beforeEach(() => {
  mocks.scopedRegistryChannelIds.clear();
});

function resolveFixtureOutboundChannelPlugin({ channel }: { channel: string }) {
  return deliverableChannelIds.includes(channel) || mocks.scopedRegistryChannelIds.has(channel)
    ? { id: channel }
    : undefined;
}

function makePlugin(params: {
  id: string;
  accountIds?: string[];
  resolveAccount?: (accountId: string) => unknown;
  inspectAccount?: (accountId: string) => unknown;
  isEnabled?: (account: unknown) => boolean;
  isConfigured?: (account: unknown) => boolean | Promise<boolean>;
}) {
  return {
    id: params.id,
    config: {
      listAccountIds: () => params.accountIds ?? ["default"],
      resolveAccount: (_cfg: unknown, accountId: string) =>
        params.resolveAccount ? params.resolveAccount(accountId) : {},
      ...(params.inspectAccount
        ? {
            inspectAccount: (_cfg: unknown, accountId: string) =>
              params.inspectAccount?.(accountId),
          }
        : {}),
      ...(params.isEnabled ? { isEnabled: params.isEnabled } : {}),
      ...(params.isConfigured ? { isConfigured: params.isConfigured } : {}),
    },
  };
}

describe("listConfiguredMessageChannels", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listRuntimeVisibleChannelPlugins.mockReset();
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(resolveFixtureOutboundChannelPlugin);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it.each([
    {
      plugins: [
        makePlugin({
          id: "gamma",
          accountIds: ["disabled", "enabled"],
          resolveAccount: (accountId) =>
            accountId === "disabled" ? { enabled: false } : { enabled: true },
          isConfigured: (account) => (account as { enabled?: boolean }).enabled === true,
        }),
      ],
      expected: ["gamma"],
      expectedErrors: 0,
    },
  ])("lists configured channels for %j", async ({ plugins, expected, expectedErrors }) => {
    mocks.listChannelPlugins.mockReturnValue(plugins);
    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual(expected);
    expect(errorSpy).toHaveBeenCalledTimes(expectedErrors);
  });

  it("refreshes recent errors and re-logs errors evicted from the bounded dedupe", async () => {
    const listWithAccounts = async (accountIds: string[]) => {
      mocks.listChannelPlugins.mockReturnValue([
        makePlugin({
          id: "alpha",
          accountIds,
          resolveAccount: () => {
            throw new Error("boom");
          },
        }),
      ]);
      await listConfiguredMessageChannels({} as never);
    };

    await listWithAccounts(Array.from({ length: 1024 }, (_, index) => `account-${index}`));
    expect(errorSpy).toHaveBeenCalledTimes(1024);

    await listWithAccounts(["account-0"]);
    expect(errorSpy).toHaveBeenCalledTimes(1024);

    await listWithAccounts(["account-overflow"]);
    expect(errorSpy).toHaveBeenCalledTimes(1025);
    await listWithAccounts(["account-0"]);
    expect(errorSpy).toHaveBeenCalledTimes(1025);
    await listWithAccounts(["account-1"]);
    expect(errorSpy).toHaveBeenCalledTimes(1026);
  });
});

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listRuntimeVisibleChannelPlugins.mockReset();
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(resolveFixtureOutboundChannelPlugin);
    mocks.missingOfficialExternalChannels.clear();
  });

  it("resolves the fallback channel", async () => {
    await expect(
      resolveMessageChannelSelection({ cfg: {} as never, fallbackChannel: "gamma" }),
    ).resolves.toMatchObject({ channel: "gamma" });
  });

  it.each([
    {
      name: "finds an inspected secondary account after a disabled default",
      accountResolution: "read_only" as const,
      accountIds: ["default", "secondary"],
      inspect: (accountId: string) => ({
        enabled: accountId === "secondary",
        configured: true,
      }),
      resolve: () => {
        throw new Error("strict resolution must not run");
      },
      configured: () => {
        throw new Error("strict configured check must not run");
      },
      expected: true,
      inspectCalls: ["default", "secondary"],
      resolveCalls: 0,
    },
    {
      name: "contains read-only inspector failures to their account",
      accountResolution: "read_only" as const,
      accountIds: ["default"],
      inspect: () => {
        throw new Error("inspection failed");
      },
      resolve: () => {
        throw new Error("strict resolution must not run");
      },
      configured: () => true,
      expected: false,
      inspectCalls: ["default"],
      resolveCalls: 0,
    },
    {
      name: "retains strict callback fallback for plugins without an inspector",
      accountResolution: "read_only" as const,
      accountIds: ["default"],
      inspect: undefined,
      resolve: () => ({ enabled: true, configured: false }),
      configured: () => true,
      expected: true,
      inspectCalls: [],
      resolveCalls: 1,
    },
  ])("$name", async (scenario) => {
    const inspectAccount = scenario.inspect ? vi.fn(scenario.inspect) : undefined;
    const resolveAccount = vi.fn(scenario.resolve);
    const isConfigured = vi.fn(scenario.configured);
    const plugin = makePlugin({
      id: "delta",
      accountIds: scenario.accountIds,
      inspectAccount,
      resolveAccount,
      isEnabled: (account) => (account as { enabled?: boolean }).enabled !== false,
      isConfigured,
    });
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    const params = {
      cfg: {} as never,
      ...(scenario.accountResolution ? { accountResolution: scenario.accountResolution } : {}),
    };

    if (scenario.expected) {
      await expect(resolveMessageChannelSelection(params)).resolves.toMatchObject({
        channel: "delta",
      });
    } else {
      await expect(resolveMessageChannelSelection(params)).rejects.toThrow(
        "Channel is required (no configured channels detected).",
      );
    }
    expect(inspectAccount?.mock.calls.map(([accountId]) => accountId) ?? []).toEqual(
      scenario.inspectCalls,
    );
    expect(resolveAccount).toHaveBeenCalledTimes(scenario.resolveCalls);
    if (scenario.accountResolution === "read_only" && scenario.inspect) {
      expect(isConfigured).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      params: { cfg: {} as never, channel: "channel:C123", fallbackChannel: "not-a-channel" },
      expectedMessage:
        'Unknown channel "channel:c123". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      setup: () => {
        mocks.scopedRegistryChannelIds.add("scopex");
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
      },
      params: { cfg: {} as never, channel: "scopex" },
      expectedMessage: "Channel is unavailable: scopex",
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
        mocks.missingOfficialExternalChannels.add("feishu");
      },
      params: {
        cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
        channel: "feishu",
      },
      expectedMessage:
        "Channel is unavailable: feishu. Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
        mocks.missingOfficialExternalChannels.add("whatsapp");
      },
      params: { cfg: { channels: { whatsapp: { enabled: true } } } as never },
      expectedMessage:
        "Channel is required (no available channels detected). Configured official external channel WhatsApp is missing its plugin. Install the official external plugin with: openclaw plugins install @openclaw/whatsapp, or run: openclaw doctor --fix.",
    },
    {
      setup: () => {
        mocks.listChannelPlugins.mockReturnValue([
          makePlugin({ id: "beta", isConfigured: async () => true }),
          makePlugin({ id: "gamma", isConfigured: async () => true }),
        ]);
      },
      params: { cfg: {} as never },
      expectedMessage:
        "Channel is required when multiple channels are configured: beta, gamma. Pass --channel <channel> to choose one.",
    },
  ])("rejects invalid channel selection for %j", async ({ setup, params, expectedMessage }) => {
    setup?.();
    await expect(resolveMessageChannelSelection(params)).rejects.toThrow(expectedMessage);
  });
});

describe("resolveMessageChannelSelection (registry-scoped channel plugins)", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listRuntimeVisibleChannelPlugins.mockReset();
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(resolveFixtureOutboundChannelPlugin);
  });

  it("defaults to the single configured channel seen only through the runtime-visible list", async () => {
    mocks.scopedRegistryChannelIds.add("scopex");
    mocks.listRuntimeVisibleChannelPlugins.mockReturnValue([
      makePlugin({ id: "scopex", resolveAccount: () => ({ enabled: true }) }),
    ]);

    const selection = await resolveMessageChannelSelection({ cfg: {} as never });
    expect(selection.channel).toBe("scopex");
  });
});
