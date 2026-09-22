// Channel setup fallback tests cover catalog fallback reuse of loaded plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setupChannels } from "./channel-setup.js";
import {
  externalChatSetupEntries,
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeExternalChatSetupPlugin,
  makeMeta,
  makePluginRegistry,
  makeSetupPlugin,
} from "./channel-setup.test-helpers.js";

type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type CollectChannelStatus = typeof import("./channel-setup.status.js").collectChannelStatus;
type EnsureChannelSetupPluginInstalled =
  typeof import("../commands/channel-setup/plugin-install.js").ensureChannelSetupPluginInstalled;
type LoadChannelSetupPluginRegistrySnapshotForChannel =
  typeof import("../commands/channel-setup/plugin-install.js").loadChannelSetupPluginRegistrySnapshotForChannel;

const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn((_cfg?: unknown) => "default"));
const listTrustedChannelPluginCatalogEntries = vi.hoisted(() =>
  vi.fn((_params?: unknown): unknown[] => []),
);
const getTrustedChannelPluginCatalogEntry = vi.hoisted(() =>
  vi.fn((_channelId: string, _params?: unknown): unknown => undefined),
);
const getChannelSetupPlugin = vi.hoisted(() => vi.fn((_channel?: unknown) => undefined));
const listChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const listActiveChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadChannelSetupPluginRegistrySnapshotForChannel = vi.hoisted(() =>
  vi.fn((_params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0]) =>
    makePluginRegistry(),
  ),
);
const ensureChannelSetupPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg, entry }: Parameters<EnsureChannelSetupPluginInstalled>[0]) => ({
    cfg,
    installed: true,
    pluginId: entry?.pluginId,
    status: "installed",
  })),
);
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn(
    (
      _params: Parameters<ResolveChannelSetupEntries>[0],
    ): ReturnType<ResolveChannelSetupEntries> => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }),
  ),
);
const collectChannelStatus = vi.hoisted(() =>
  vi.fn(async (_params: Parameters<CollectChannelStatus>[0]) => ({
    installedPlugins: [],
    catalogEntries: [],
    installedCatalogEntries: [],
    statusByChannel: new Map(),
    statusLines: [],
  })),
);
const resolveChannelSetupWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown) => "/tmp/openclaw-workspace"),
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
  normalizeAnyChannelId: (channelId?: unknown) =>
    typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
  normalizeChatChannelId: (channelId?: unknown) =>
    typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: (params: Parameters<ResolveChannelSetupEntries>[0]) =>
    resolveChannelSetupEntries(params),
  shouldShowChannelInSetup: () => true,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: (params: Parameters<EnsureChannelSetupPluginInstalled>[0]) =>
    ensureChannelSetupPluginInstalled(params),
  loadChannelSetupPluginRegistrySnapshotForChannel: (
    params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0],
  ) => loadChannelSetupPluginRegistrySnapshotForChannel(params),
}));

vi.mock("../commands/channel-setup/registry.js", () => ({
  resolveChannelSetupWizardAdapterForPlugin: (plugin?: { setupWizard?: unknown }) =>
    plugin?.setupWizard,
}));

vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: (params?: unknown) =>
    listTrustedChannelPluginCatalogEntries(params),
  getTrustedChannelPluginCatalogEntry: (channelId: string, params?: unknown) =>
    getTrustedChannelPluginCatalogEntry(channelId, params),
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (cfg?: unknown, channel?: unknown) => isChannelConfigured(cfg, channel),
}));

vi.mock("./channel-setup.prompts.js", () => ({
  maybeConfigureCommandOwner: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
  maybeConfigureDmPolicies: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
  promptConfiguredAction: vi.fn(),
  promptRemovalAccountId: vi.fn(),
  formatAccountLabel: vi.fn(),
}));

vi.mock("./channel-setup.status.js", () => ({
  collectChannelStatus: (params: Parameters<CollectChannelStatus>[0]) =>
    collectChannelStatus(params),
  findBundledSourceForCatalogChannel: vi.fn(() => undefined),
  noteChannelPrimer: vi.fn(),
  noteChannelStatus: vi.fn(),
  resolveCatalogChannelSelectionHint: vi.fn(() => "download from <npm>"),
  resolveChannelSelectionNoteLines: vi.fn(() => []),
  resolveChannelSetupSelectionContributions: vi.fn(() => []),
  resolveChannelSetupWorkspaceDir: (cfg?: unknown) => resolveChannelSetupWorkspaceDir(cfg),
  resolveQuickstartDefault: vi.fn(() => undefined),
}));

const TARGETED_CHANNEL_SETUP_OPTIONS = {
  initialSelection: ["external-chat"],
  finishAfterInitialSelection: true,
  deferStatusUntilSelection: true,
  skipDmPolicyPrompt: true,
} satisfies NonNullable<Parameters<typeof setupChannels>[3]>;

function runChannelSetup(
  cfg: OpenClawConfig,
  prompter: Record<string, unknown>,
  options?: Parameters<typeof setupChannels>[3],
) {
  return setupChannels(
    cfg,
    {} as never,
    {
      confirm: vi.fn(async () => true),
      note: vi.fn(async () => undefined),
      ...prompter,
    } as never,
    options,
  );
}

describe("setupChannels catalog fallback plugin reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    resolveDefaultAgentId.mockReturnValue("default");
    resolveChannelSetupWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
        origin: "bundled",
      },
    ]);
    getTrustedChannelPluginCatalogEntry.mockReturnValue(
      makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      }),
    );
    getChannelSetupPlugin.mockReturnValue(undefined);
    listActiveChannelSetupPlugins.mockReturnValue([]);
    listChannelSetupPlugins.mockReturnValue([]);
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
    ensureChannelSetupPluginInstalled.mockImplementation(async ({ cfg, entry }) => ({
      cfg,
      installed: true,
      pluginId: entry?.pluginId,
      status: "installed",
    }));
    resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: [],
    });
    isChannelConfigured.mockReturnValue(true);
  });

  it(
    "reuses an already-loaded catalog plugin instead of driving the " +
      "catalog-fallback reinstall",
    async () => {
      // Regression for #149672: a catalog-backed channel whose plugin is
      // already loaded (sms installed + enabled + listed by the gateway) is
      // excluded from BOTH discovery buckets — installedCatalogEntries and
      // installableCatalogEntries both filter out ids present in
      // installedPlugins. The catalog fallback must not read the empty pair
      // as "plugin missing": before the fix it drove
      // ensureChannelSetupPluginInstalled unconditionally, rewriting
      // plugins.installs.<id>.installPath and restarting the gateway under
      // the page that asked for the install.
      const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: { ...cfg, channels: { "external-chat": { token: "secret" } } },
      }));
      const loadedPlugin = makeExternalChatSetupPlugin({ configure });
      listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
      // Discovery returns the channel in `entries` but keeps both catalog
      // buckets empty, which is exactly how resolveChannelSetupEntries treats
      // a loaded catalog-backed plugin.
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [],
          installableCatalogEntries: [],
          installedCatalogById: new Map(),
          installableCatalogById: new Map(),
        }),
      );
      getTrustedChannelPluginCatalogEntry.mockReturnValue(
        makeCatalogEntry("external-chat", "External Chat", {
          pluginId: "@vendor/external-chat-plugin",
          install: { npmSpec: "@vendor/external-chat-plugin" },
        }),
      );
      isChannelConfigured.mockReturnValue(false);
      const note = vi.fn(async () => undefined);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");

      await runChannelSetup({}, { note, select }, TARGETED_CHANNEL_SETUP_OPTIONS);

      // The loaded plugin is reused: no reinstall, no "plugin not available"
      // dead-end, and the channel's own configure step still runs.
      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
      expect(configure).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "unrestricted", allow: undefined },
    { label: "owner-only allowlist", allow: ["workspace-chat"] },
  ])("preserves loaded catalog plugin settings with $label", async ({ allow }) => {
    const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: { ...cfg, channels: { "custom-chat": { token: "fixture-token" } } },
    }));
    const loadedPlugin = makeSetupPlugin({
      id: "custom-chat",
      label: "Custom Chat",
      setupWizard: {
        channel: "custom-chat",
        getStatus: vi.fn(async () => ({
          channel: "custom-chat",
          configured: false,
          statusLines: [],
        })),
        configure,
      } as ChannelSetupPlugin["setupWizard"],
    });
    listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [{ id: "custom-chat", meta: makeMeta("custom-chat", "Custom Chat") }],
      }),
    );
    getTrustedChannelPluginCatalogEntry.mockReturnValue(
      makeCatalogEntry("custom-chat", "Custom Chat", {
        pluginId: "workspace-chat",
        install: { npmSpec: "workspace-chat" },
      }),
    );
    isChannelConfigured.mockReturnValue(false);
    const cfg: OpenClawConfig = {
      plugins: {
        ...(allow ? { allow } : {}),
        entries: { "workspace-chat": { enabled: true, config: { mode: "existing" } } },
      },
    };
    const note = vi.fn(async () => undefined);
    const next = await runChannelSetup(
      cfg,
      { note },
      { ...TARGETED_CHANNEL_SETUP_OPTIONS, initialSelection: ["custom-chat"] },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(next).toEqual({
      ...cfg,
      channels: { "custom-chat": { token: "fixture-token" } },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("keeps the disabled-policy guard when reusing a loaded plugin", async () => {
    // The reuse path preserves the same operator-disabled guard the catalog
    // fallback and bundled-enable paths enforce: an explicitly disabled
    // channel must stop with the "Enable it before setup." note even though
    // its plugin is loaded.
    const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({ cfg }));
    const loadedPlugin = makeExternalChatSetupPlugin({ configure });
    listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installedCatalogEntries: [],
        installableCatalogEntries: [],
        installedCatalogById: new Map(),
        installableCatalogById: new Map(),
      }),
    );
    isChannelConfigured.mockReturnValue(false);
    const note = vi.fn(async () => undefined);
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");

    await runChannelSetup(
      { channels: { "external-chat": { enabled: false } } } as never,
      { note, select },
      // No deferStatusUntilSelection: bypass the top-level deferred guard so
      // the empty-buckets branch guard is what fires.
      { skipConfirm: true, skipDmPolicyPrompt: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "external-chat cannot be configured while disabled. Enable it before setup.",
      "Channel setup",
    );
  });
});
