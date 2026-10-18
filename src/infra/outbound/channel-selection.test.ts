import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyChannelPlugin } from "../../channels/plugins/types.plugin.js";
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
  isDeliverableMessageChannel: (value: string) => deliverableChannelIds.includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

vi.mock("./channel-resolution.js", () => ({
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
    missingPluginHint(channelId),
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) => channelIds.flatMap((channelId) => missingPluginHint(channelId) ?? []),
}));

function missingPluginHint(channelId: string) {
  return mocks.missingOfficialExternalChannels.has(channelId)
    ? {
        channelId,
        label: channelId === "whatsapp" ? "WhatsApp" : "Feishu",
        installCommand: `openclaw plugins install @openclaw/${channelId}`,
        repairHint: `Install the official external plugin with: openclaw plugins install @openclaw/${channelId}, or run: openclaw doctor --fix.`,
      }
    : null;
}

type ChannelSelectionModule = typeof import("./channel-selection.js");

let listConfiguredMessageChannels: ChannelSelectionModule["listConfiguredMessageChannels"];
let resolveMessageChannelSelection: ChannelSelectionModule["resolveMessageChannelSelection"];

beforeAll(async () => {
  ({ listConfiguredMessageChannels, resolveMessageChannelSelection } =
    await import("./channel-selection.js"));
});

beforeEach(() => {
  mocks.scopedRegistryChannelIds.clear();
  mocks.listChannelPlugins.mockReset().mockReturnValue([]);
  mocks.listRuntimeVisibleChannelPlugins.mockReset();
  mocks.resolveOutboundChannelPlugin
    .mockReset()
    .mockImplementation(resolveFixtureOutboundChannelPlugin);
  mocks.missingOfficialExternalChannels.clear();
});

function resolveFixtureOutboundChannelPlugin({ channel }: { channel: string }) {
  return deliverableChannelIds.includes(channel) || mocks.scopedRegistryChannelIds.has(channel)
    ? { id: channel }
    : undefined;
}

function makePlugin(id: string, config: Partial<AnyChannelPlugin["config"]> = {}) {
  return {
    id,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      ...config,
    },
  };
}

describe("listConfiguredMessageChannels", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("lists configured channels after a disabled account", async () => {
    mocks.listChannelPlugins.mockReturnValue([
      makePlugin("gamma", {
        listAccountIds: () => ["disabled", "enabled"],
        resolveAccount: (_cfg, accountId) =>
          accountId === "disabled" ? { enabled: false } : { enabled: true },
        isConfigured: (account) => (account as { enabled?: boolean }).enabled === true,
      }),
    ]);
    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual(["gamma"]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("refreshes recent errors and re-logs errors evicted from the bounded dedupe", async () => {
    const listWithAccounts = async (accountIds: string[], errors: number) => {
      mocks.listChannelPlugins.mockReturnValue([
        makePlugin("alpha", {
          listAccountIds: () => accountIds,
          resolveAccount: () => {
            throw new Error("boom");
          },
        }),
      ]);
      await listConfiguredMessageChannels({} as never);
      expect(errorSpy).toHaveBeenCalledTimes(errors);
    };

    await listWithAccounts(
      Array.from({ length: 1024 }, (_, index) => `account-${index}`),
      1024,
    );
    await listWithAccounts(["account-0"], 1024);
    await listWithAccounts(["account-overflow"], 1025);
    await listWithAccounts(["account-0"], 1025);
    await listWithAccounts(["account-1"], 1026);
  });
});

describe("resolveMessageChannelSelection", () => {
  it("resolves the fallback channel", async () => {
    await expect(
      resolveMessageChannelSelection({ cfg: {} as never, fallbackChannel: "gamma" }),
    ).resolves.toMatchObject({ channel: "gamma" });
  });

  it.each([
    ["secondary", true, ["default", "secondary"], 0],
    ["inspection-error", false, ["default"], 0],
    ["no-inspector", true, [], 1],
  ] as const)(
    "resolves read-only accounts: %s",
    async (mode, expected, inspectCalls, resolveCalls) => {
      const inspectAccount =
        mode === "no-inspector"
          ? undefined
          : vi.fn((accountId: string) => {
              if (mode === "inspection-error") {
                throw new Error("inspection failed");
              }
              return { enabled: accountId === "secondary", configured: true };
            });
      const resolveAccount = vi.fn(() => {
        if (mode !== "no-inspector") {
          throw new Error("strict resolution must not run");
        }
        return { enabled: true, configured: false };
      });
      const isConfigured = vi.fn(() => {
        if (mode === "secondary") {
          throw new Error("strict configured check must not run");
        }
        return true;
      });
      mocks.listChannelPlugins.mockReturnValue([
        makePlugin("delta", {
          listAccountIds: () => (mode === "secondary" ? ["default", "secondary"] : ["default"]),
          inspectAccount: inspectAccount ? (_cfg, id) => inspectAccount(id) : undefined,
          resolveAccount,
          isConfigured,
          isEnabled: (account) => (account as { enabled?: boolean }).enabled !== false,
        }),
      ]);
      const selection = resolveMessageChannelSelection({
        cfg: {} as never,
        accountResolution: "read_only",
      });
      if (expected) {
        await expect(selection).resolves.toMatchObject({ channel: "delta" });
      } else {
        await expect(selection).rejects.toThrow(
          "Channel is required (no configured channels detected).",
        );
      }
      expect(inspectAccount?.mock.calls.map(([id]) => id) ?? []).toEqual(inspectCalls);
      expect(resolveAccount).toHaveBeenCalledTimes(resolveCalls);
      if (inspectAccount) {
        expect(isConfigured).not.toHaveBeenCalled();
      }
    },
  );

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
        mocks.missingOfficialExternalChannels.add("feishu");
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
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
        mocks.missingOfficialExternalChannels.add("whatsapp");
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
      },
      params: { cfg: { channels: { whatsapp: { enabled: true } } } as never },
      expectedMessage:
        "Channel is required (no available channels detected). Configured official external channel WhatsApp is missing its plugin. Install the official external plugin with: openclaw plugins install @openclaw/whatsapp, or run: openclaw doctor --fix.",
    },
    {
      setup: () =>
        mocks.listChannelPlugins.mockReturnValue(
          ["beta", "gamma"].map((id) => makePlugin(id, { isConfigured: async () => true })),
        ),
      params: { cfg: {} as never },
      expectedMessage:
        "Channel is required when multiple channels are configured: beta, gamma. Pass --channel <channel> to choose one.",
    },
  ])("rejects invalid channel selection for %j", async ({ setup, params, expectedMessage }) => {
    setup?.();
    await expect(resolveMessageChannelSelection(params)).rejects.toThrow(expectedMessage);
  });
  it("defaults to the single configured channel seen only through the runtime-visible list", async () => {
    mocks.scopedRegistryChannelIds.add("scopex");
    mocks.listRuntimeVisibleChannelPlugins.mockReturnValue([
      makePlugin("scopex", { resolveAccount: () => ({ enabled: true }) }),
    ]);

    const selection = await resolveMessageChannelSelection({ cfg: {} as never });
    expect(selection.channel).toBe("scopex");
  });
});
