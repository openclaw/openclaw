import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn((_cfg?: unknown) => "default"));
const listTrustedChannelPluginCatalogEntries = vi.hoisted(() =>
  vi.fn((_params?: unknown): unknown[] => []),
);
const getChannelSetupPlugin = vi.hoisted(() => vi.fn((_channel?: unknown) => undefined));
const listChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const listActiveChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadChannelSetupPluginRegistrySnapshotForChannel = vi.hoisted(() =>
  vi.fn(
    (
      _params?: unknown,
    ): {
      channels: unknown[];
      channelSetups: unknown[];
    } => ({ channels: [], channelSetups: [] }),
  ),
);
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn(
    (
      _params?: unknown,
    ): {
      entries: unknown[];
      installedCatalogEntries: unknown[];
      installableCatalogEntries: unknown[];
      installedCatalogById: Map<unknown, unknown>;
      installableCatalogById: Map<unknown, unknown>;
    } => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }),
  ),
);
const collectChannelStatus = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({
    installedPlugins: [],
    catalogEntries: [],
    installedCatalogEntries: [],
    statusByChannel: new Map(),
    statusLines: [],
  })),
);
const isChannelConfigured = vi.hoisted(() => vi.fn((_cfg?: unknown, _channel?: unknown) => true));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (cfg?: unknown, agentId?: unknown) =>
    resolveAgentWorkspaceDir(cfg, agentId),
  resolveDefaultAgentId: (cfg?: unknown) => resolveDefaultAgentId(cfg),
}));

vi.mock("../channels/plugins/setup-registry.js", () => ({
  getChannelSetupPlugin: (channel?: unknown) => getChannelSetupPlugin(channel),
  listActiveChannelSetupPlugins: () => listActiveChannelSetupPlugins(),
  listChannelSetupPlugins: () => listChannelSetupPlugins(),
}));

vi.mock("../channels/registry.js", () => ({
  getChatChannelMeta: (channelId: string) => ({ id: channelId, label: channelId }),
  listChatChannels: () => [],
  normalizeChatChannelId: (channelId?: unknown) =>
    typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: (params?: unknown) => resolveChannelSetupEntries(params),
  shouldShowChannelInSetup: () => true,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: (params?: unknown) =>
    loadChannelSetupPluginRegistrySnapshotForChannel(params),
}));

vi.mock("../commands/channel-setup/registry.js", () => ({
  resolveChannelSetupWizardAdapterForPlugin: (plugin?: { setupWizard?: unknown }) =>
    plugin?.setupWizard,
}));

vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: (params?: unknown) =>
    listTrustedChannelPluginCatalogEntries(params),
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (cfg?: unknown, channel?: unknown) => isChannelConfigured(cfg, channel),
}));

vi.mock("./channel-setup.prompts.js", () => ({
  maybeConfigureDmPolicies: vi.fn(),
  promptConfiguredAction: vi.fn(),
  promptRemovalAccountId: vi.fn(),
  formatAccountLabel: vi.fn(),
}));

vi.mock("./channel-setup.status.js", () => ({
  collectChannelStatus: (params?: unknown) => collectChannelStatus(params),
  noteChannelPrimer: vi.fn(),
  noteChannelStatus: vi.fn(),
  resolveChannelSelectionNoteLines: vi.fn(() => []),
  resolveChannelSetupSelectionContributions: vi.fn(() => []),
  resolveQuickstartDefault: vi.fn(() => undefined),
}));

import { setupChannels } from "./channel-setup.js";

describe("setupChannels workspace shadow exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    resolveDefaultAgentId.mockReturnValue("default");
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "telegram",
        pluginId: "@openclaw/telegram-plugin",
        origin: "bundled",
      },
    ]);
    getChannelSetupPlugin.mockReturnValue(undefined);
    listActiveChannelSetupPlugins.mockReturnValue([]);
    listChannelSetupPlugins.mockReturnValue([]);
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [],
      channelSetups: [],
    });
    resolveChannelSetupEntries.mockReturnValue({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: [],
    });
    isChannelConfigured.mockReturnValue(true);
  });

  it("preloads configured external plugins from the trusted catalog boundary", async () => {
    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => false),
        note: vi.fn(async () => undefined),
      } as never,
    );

    expect(listTrustedChannelPluginCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "@openclaw/telegram-plugin",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });

  it("keeps trusted workspace overrides eligible during preload", async () => {
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      { id: "telegram", pluginId: "trusted-telegram-shadow", origin: "workspace" },
    ]);

    await setupChannels(
      {
        plugins: {
          enabled: true,
          allow: ["trusted-telegram-shadow"],
        },
      } as never,
      {} as never,
      {
        confirm: vi.fn(async () => false),
        note: vi.fn(async () => undefined),
      } as never,
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "trusted-telegram-shadow",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });

  it("defers status and setup-plugin loads until a channel is selected", async () => {
    resolveChannelSetupEntries.mockReturnValue({
      entries: [
        {
          id: "telegram",
          meta: { id: "telegram", label: "Telegram", blurb: "" },
        },
      ],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    const select = vi.fn(async () => "__done__");

    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
      },
    );

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(listTrustedChannelPluginCatalogEntries).not.toHaveBeenCalled();
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
  });

  it("keeps already-active setup plugins in the deferred picker without registry fallback", async () => {
    const activePlugin = {
      id: "custom-chat",
      meta: { id: "custom-chat", label: "Custom Chat", blurb: "" },
    };
    listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
    resolveChannelSetupEntries.mockImplementation(() => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }));
    const select = vi.fn(async () => "__done__");

    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
      },
    );

    expect(resolveChannelSetupEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        installedPlugins: [activePlugin],
      }),
    );
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
  });

  it("uses an active deferred setup plugin without enabling config on selection", async () => {
    const setupWizard = {
      channel: "custom-chat",
      getStatus: vi.fn(async () => ({
        channel: "custom-chat",
        configured: false,
        statusLines: [],
      })),
      configure: vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: {
          ...cfg,
          channels: {
            "custom-chat": { token: "secret" },
          },
        },
      })),
    };
    const activePlugin = {
      id: "custom-chat",
      meta: { id: "custom-chat", label: "Custom Chat", blurb: "" },
      capabilities: {},
      config: {
        resolveAccount: vi.fn(() => ({})),
      },
      setupWizard,
    };
    listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
    resolveChannelSetupEntries.mockReturnValue({
      entries: [
        {
          id: "custom-chat",
          meta: { id: "custom-chat", label: "Custom Chat", blurb: "" },
        },
      ],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    const select = vi.fn().mockResolvedValueOnce("custom-chat").mockResolvedValueOnce("__done__");

    const next = await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(setupWizard.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
      }),
    );
    expect(next).toEqual({
      channels: {
        "custom-chat": { token: "secret" },
      },
    });
  });

  it("loads the selected bundled catalog plugin without writing explicit plugin enablement", async () => {
    const setupWizard = {
      channel: "telegram",
      getStatus: vi.fn(async () => ({
        channel: "telegram",
        configured: false,
        statusLines: [],
      })),
      configure: vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: {
          ...cfg,
          channels: {
            telegram: { token: "secret" },
          },
        },
      })),
    };
    const telegramPlugin = {
      id: "telegram",
      meta: { id: "telegram", label: "Telegram", blurb: "" },
      capabilities: {},
      config: {
        resolveAccount: vi.fn(() => ({})),
      },
      setupWizard,
    };
    const installedCatalogEntry = {
      id: "telegram",
      pluginId: "telegram",
      origin: "bundled",
      meta: { id: "telegram", label: "Telegram", blurb: "" },
    };
    resolveChannelSetupEntries.mockReturnValue({
      entries: [
        {
          id: "telegram",
          meta: { id: "telegram", label: "Telegram", blurb: "" },
        },
      ],
      installedCatalogEntries: [installedCatalogEntry],
      installableCatalogEntries: [],
      installedCatalogById: new Map([["telegram", installedCatalogEntry]]),
      installableCatalogById: new Map(),
    });
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [{ plugin: telegramPlugin }],
      channelSetups: [],
    });
    const select = vi.fn().mockResolvedValueOnce("telegram").mockResolvedValueOnce("__done__");

    const next = await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "telegram",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(setupWizard.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
      }),
    );
    expect(next).toEqual({
      channels: {
        telegram: { token: "secret" },
      },
    });
  });

  it("does not load or re-enable an explicitly disabled channel when selected lazily", async () => {
    const setupWizard = {
      channel: "telegram",
      getStatus: vi.fn(async () => ({
        channel: "telegram",
        configured: true,
        statusLines: [],
      })),
      configure: vi.fn(),
    };
    resolveChannelSetupEntries.mockReturnValue({
      entries: [
        {
          id: "telegram",
          meta: { id: "telegram", label: "Telegram", blurb: "" },
        },
      ],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    const select = vi.fn().mockResolvedValueOnce("telegram").mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => undefined);
    const cfg = {
      channels: {
        telegram: { enabled: false, token: "secret" },
      },
    };

    const next = await setupChannels(
      cfg as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note,
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "telegram cannot be configured while disabled. Enable it before setup.",
      "Channel setup",
    );
    expect(setupWizard.configure).not.toHaveBeenCalled();
    expect(next).toEqual({
      channels: {
        telegram: { enabled: false, token: "secret" },
      },
    });
  });

  it("honors global plugin disablement before lazy channel setup loads plugins", async () => {
    resolveChannelSetupEntries.mockReturnValue({
      entries: [
        {
          id: "telegram",
          meta: { id: "telegram", label: "Telegram", blurb: "" },
        },
      ],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    const select = vi.fn().mockResolvedValueOnce("telegram").mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => undefined);
    const cfg = {
      plugins: { enabled: false },
      channels: {
        telegram: { enabled: true, token: "secret" },
      },
    };

    await setupChannels(
      cfg as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note,
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "telegram cannot be configured while plugins disabled. Enable it before setup.",
      "Channel setup",
    );
  });
});
