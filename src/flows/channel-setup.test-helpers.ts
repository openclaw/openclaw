// Channel setup test helpers build channel metadata and prompt fixtures.
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

type ChannelMeta = import("../channels/plugins/types.core.js").ChannelMeta;
type ChannelPluginCatalogEntry = import("../channels/plugins/catalog.js").ChannelPluginCatalogEntry;
type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;
type ChannelSetupWizardAdapter =
  import("../channels/plugins/setup-wizard-types.js").ChannelSetupWizardAdapter;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type LoadChannelSetupPluginRegistrySnapshotForChannel =
  typeof import("../commands/channel-setup/plugin-install.js").loadChannelSetupPluginRegistrySnapshotForChannel;
type PluginRegistry = ReturnType<LoadChannelSetupPluginRegistrySnapshotForChannel>;

// Small builders for channel setup tests; mirror discovery shapes without loading real plugins.
type ChannelSetupEntries = ReturnType<ResolveChannelSetupEntries>;

/** Builds channel metadata with the defaults most setup tests need. */
export function makeMeta(
  id: string,
  label: string,
  overrides: Partial<ChannelMeta> = {},
): ChannelMeta {
  return {
    id: id as ChannelMeta["id"],
    label,
    selectionLabel: overrides.selectionLabel ?? label,
    docsPath: overrides.docsPath ?? `/channels/${id}`,
    blurb: overrides.blurb ?? "",
    ...overrides,
  };
}

/** Builds a catalog entry for an installable or installed channel plugin. */
export function makeCatalogEntry(
  id: string,
  label: string,
  overrides: Partial<ChannelPluginCatalogEntry> = {},
): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: overrides.pluginId ?? id,
    meta: makeMeta(id, label, overrides.meta),
    install: overrides.install ?? { npmSpec: `@openclaw/${id}` },
    ...overrides,
  };
}

/** Builds the full discovery result shape used by channel setup flows. */
export function makeChannelSetupEntries(
  overrides: Partial<ChannelSetupEntries> = {},
): ChannelSetupEntries {
  return {
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
    ...overrides,
  };
}

/** Builds a minimal channel setup plugin fixture with mocked config hooks. */
export function makeSetupPlugin(params: {
  id: string;
  label: string;
  setupWizard?: ChannelSetupPlugin["setupWizard"];
}): ChannelSetupPlugin {
  return {
    id: params.id as ChannelSetupPlugin["id"],
    meta: makeMeta(params.id, params.label),
    capabilities: { chatTypes: [] },
    config: {
      listAccountIds: vi.fn(() => ["default"]),
      resolveAccount: vi.fn(() => ({})),
    } as unknown as ChannelSetupPlugin["config"],
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
  };
}

/** Builds the external-chat setup plugin used by catalog fallback tests. */
export function makeExternalChatSetupPlugin(
  setupWizard: Pick<ChannelSetupWizardAdapter, "configure"> & Partial<ChannelSetupWizardAdapter>,
): ChannelSetupPlugin {
  return makeSetupPlugin({
    id: "external-chat",
    label: "External Chat",
    setupWizard: {
      channel: "external-chat",
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: false,
        statusLines: [],
      })),
      ...setupWizard,
    },
  });
}

/** Builds discovery results exposing external-chat with overridable buckets. */
export function externalChatSetupEntries(
  overrides: Partial<ReturnType<ResolveChannelSetupEntries>> = {},
) {
  return makeChannelSetupEntries({
    entries: [
      {
        id: "external-chat",
        meta: makeMeta("external-chat", "External Chat"),
      },
    ],
    ...overrides,
  });
}

/** Builds an empty plugin registry snapshot with the given overrides. */
export function makePluginRegistry(overrides: Partial<PluginRegistry> = {}): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  for (const key of Object.keys(overrides) as Array<keyof PluginRegistry>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(registry, { [key]: value });
    }
  }
  return registry;
}

type CollectChannelStatus = typeof import("./channel-setup.status.js").collectChannelStatus;
type EnsureChannelSetupPluginInstalled =
  typeof import("../commands/channel-setup/plugin-install.js").ensureChannelSetupPluginInstalled;

export function createChannelSetupMocks() {
  const resolveAgentWorkspaceDir = vi.fn(
    (_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace",
  );
  const resolveDefaultAgentId = vi.fn((_cfg?: unknown) => "default");
  const listTrustedChannelPluginCatalogEntries = vi.fn((_params?: unknown): unknown[] => []);
  const getTrustedChannelPluginCatalogEntry = vi.fn(
    (_channelId: string, _params?: unknown): unknown => undefined,
  );
  const getChannelSetupPlugin = vi.fn((_channel?: unknown) => undefined);
  const listChannelSetupPlugins = vi.fn((): unknown[] => []);
  const listActiveChannelSetupPlugins = vi.fn((): unknown[] => []);
  const loadChannelSetupPluginRegistrySnapshotForChannel = vi.fn(
    (_params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0]) =>
      makePluginRegistry(),
  );
  const ensureChannelSetupPluginInstalled = vi.fn(
    async ({ cfg, entry }: Parameters<EnsureChannelSetupPluginInstalled>[0]) => ({
      cfg,
      installed: true,
      pluginId: entry?.pluginId,
      status: "installed",
    }),
  );
  const resolveChannelSetupEntries = vi.fn(
    (
      _params: Parameters<ResolveChannelSetupEntries>[0],
    ): ReturnType<ResolveChannelSetupEntries> => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }),
  );
  const collectChannelStatus = vi.fn(async (_params: Parameters<CollectChannelStatus>[0]) => ({
    installedPlugins: [],
    catalogEntries: [],
    installedCatalogEntries: [],
    statusByChannel: new Map(),
    statusLines: [],
  }));
  const resolveChannelSetupWorkspaceDir = vi.fn((_cfg?: unknown) => "/tmp/openclaw-workspace");
  const isChannelConfigured = vi.fn((_cfg?: unknown, _channel?: unknown) => true);
  const factories = {
    agentScope: () => ({
      resolveAgentWorkspaceDir: (cfg?: unknown, agentId?: unknown) =>
        resolveAgentWorkspaceDir(cfg, agentId),
      resolveDefaultAgentId: (cfg?: unknown) => resolveDefaultAgentId(cfg),
    }),
    setupRegistry: () => ({
      getChannelSetupPlugin: (channel?: unknown) => getChannelSetupPlugin(channel),
      listActiveChannelSetupPlugins: () => listActiveChannelSetupPlugins(),
      listChannelSetupPlugins: () => listChannelSetupPlugins(),
    }),
    channels: () => ({
      getChatChannelMeta: (channelId: string) => ({ id: channelId, label: channelId }),
      listChatChannels: () => [],
      normalizeAnyChannelId: (channelId?: unknown) =>
        typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
      normalizeChatChannelId: (channelId?: unknown) =>
        typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
    }),
    discovery: () => ({
      resolveChannelSetupEntries: (params: Parameters<ResolveChannelSetupEntries>[0]) =>
        resolveChannelSetupEntries(params),
      shouldShowChannelInSetup: () => true,
    }),
    pluginInstall: () => ({
      ensureChannelSetupPluginInstalled: (
        params: Parameters<EnsureChannelSetupPluginInstalled>[0],
      ) => ensureChannelSetupPluginInstalled(params),
      loadChannelSetupPluginRegistrySnapshotForChannel: (
        params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0],
      ) => loadChannelSetupPluginRegistrySnapshotForChannel(params),
    }),
    registry: () => ({
      resolveChannelSetupWizardAdapterForPlugin: (plugin?: { setupWizard?: unknown }) =>
        plugin?.setupWizard,
    }),
    trustedCatalog: () => ({
      listTrustedChannelPluginCatalogEntries: (params?: unknown) =>
        listTrustedChannelPluginCatalogEntries(params),
      getTrustedChannelPluginCatalogEntry: (channelId: string, params?: unknown) =>
        getTrustedChannelPluginCatalogEntry(channelId, params),
    }),
    configured: () => ({
      isChannelConfigured: (cfg?: unknown, channel?: unknown) => isChannelConfigured(cfg, channel),
    }),
    prompts: () => ({
      maybeConfigureCommandOwner: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
      maybeConfigureDmPolicies: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
      promptConfiguredAction: vi.fn(),
      promptRemovalAccountId: vi.fn(),
      formatAccountLabel: vi.fn(),
    }),
    status: () => ({
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
    }),
  };
  return {
    resolveAgentWorkspaceDir,
    resolveDefaultAgentId,
    listTrustedChannelPluginCatalogEntries,
    getTrustedChannelPluginCatalogEntry,
    getChannelSetupPlugin,
    listChannelSetupPlugins,
    listActiveChannelSetupPlugins,
    loadChannelSetupPluginRegistrySnapshotForChannel,
    ensureChannelSetupPluginInstalled,
    resolveChannelSetupEntries,
    collectChannelStatus,
    resolveChannelSetupWorkspaceDir,
    isChannelConfigured,
    factories,
  };
}
