import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

type ChannelMeta = import("../channels/plugins/types.core.js").ChannelMeta;
type ChannelPluginCatalogEntry = import("../channels/plugins/catalog.js").ChannelPluginCatalogEntry;
type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;
type ChannelSetupWizardAdapter =
  import("../channels/plugins/setup-wizard-types.js").ChannelSetupWizardAdapter;
type Discover = typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type LoadRegistryParams = Parameters<
  typeof import("../commands/channel-setup/plugin-install.js").loadChannelSetupPluginRegistrySnapshotForChannel
>[0];
type PluginRegistry = ReturnType<typeof createEmptyPluginRegistry>;

type ChannelSetupEntries = ReturnType<Discover>;

export function makeMeta(
  id: string,
  label: string,
  overrides: Partial<ChannelMeta> = {},
): ChannelMeta {
  return {
    id,
    label,
    selectionLabel: label,
    docsPath: `/channels/${id}`,
    blurb: "",
    ...overrides,
  };
}

export function makeCatalogEntry(
  id: string,
  label: string,
  overrides: Partial<ChannelPluginCatalogEntry> = {},
): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: id,
    meta: makeMeta(id, label, overrides.meta),
    install: { npmSpec: `@openclaw/${id}` },
    ...overrides,
  };
}

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

export function makeSetupPlugin(params: {
  id: string;
  label: string;
  setupWizard?: ChannelSetupPlugin["setupWizard"];
}): ChannelSetupPlugin {
  return {
    id: params.id,
    meta: makeMeta(params.id, params.label),
    capabilities: { chatTypes: [] },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
  };
}

export function makeExternalChatSetupPlugin(
  setupWizard: Pick<ChannelSetupWizardAdapter, "configure"> & Partial<ChannelSetupWizardAdapter>,
): ChannelSetupPlugin {
  return makeSetupPlugin({
    id: "external-chat",
    label: "External Chat",
    setupWizard: {
      channel: "external-chat",
      getStatus: async () => ({ channel: "external-chat", configured: false, statusLines: [] }),
      ...setupWizard,
    },
  });
}

export function externalChatSetupEntries(overrides: Partial<ReturnType<Discover>> = {}) {
  return makeChannelSetupEntries({
    entries: [{ id: "external-chat", meta: makeMeta("external-chat", "External Chat") }],
    ...overrides,
  });
}

export function makePluginRegistry(overrides: Partial<PluginRegistry> = {}): PluginRegistry {
  return { ...createEmptyPluginRegistry(), ...overrides };
}

type CollectStatus = typeof import("./channel-setup.status.js").collectChannelStatus;
type Install =
  typeof import("../commands/channel-setup/plugin-install.js").ensureChannelSetupPluginInstalled;

export function createChannelSetupMocks() {
  const agentScope = {
    resolveAgentWorkspaceDir: vi.fn(
      (_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace",
    ),
    resolveDefaultAgentId: vi.fn((_cfg?: unknown) => "default"),
  };
  const setupRegistry = {
    getChannelSetupPlugin: vi.fn((_channel?: unknown) => undefined),
    listChannelSetupPlugins: vi.fn((): unknown[] => []),
    listActiveChannelSetupPlugins: vi.fn((): unknown[] => []),
  };
  const trustedCatalog = {
    listTrustedChannelPluginCatalogEntries: vi.fn((_params?: unknown): unknown[] => [
      { id: "external-chat", pluginId: "@vendor/external-chat-plugin", origin: "bundled" },
    ]),
    getTrustedChannelPluginCatalogEntry: vi.fn(
      (_channelId: string, _params?: unknown): unknown => undefined,
    ),
  };
  const pluginInstall = {
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn((_params: LoadRegistryParams) =>
      makePluginRegistry(),
    ),
    ensureChannelSetupPluginInstalled: vi.fn(async ({ cfg, entry }: Parameters<Install>[0]) => ({
      cfg,
      installed: true,
      pluginId: entry?.pluginId,
      status: "installed",
    })),
  };
  const discovery = {
    resolveChannelSetupEntries: vi.fn((_params: Parameters<Discover>[0]) =>
      makeChannelSetupEntries(),
    ),
  };
  const configured = { isChannelConfigured: vi.fn((_cfg?: unknown, _channel?: unknown) => true) };
  const status = {
    collectChannelStatus: vi.fn<CollectStatus>(async (_params) => ({
      statusByChannel: new Map(),
      statusLines: [],
    })),
    resolveChannelSetupWorkspaceDir: vi.fn((_cfg?: unknown) => "/tmp/openclaw-workspace"),
    findBundledSourceForCatalogChannel: vi.fn(() => undefined),
    noteChannelPrimer: vi.fn(),
    resolveCatalogChannelSelectionHint: vi.fn(() => "download from <npm>"),
    resolveChannelSelectionNoteLines: vi.fn(() => []),
    resolveChannelSetupSelectionOptions: vi.fn(() => []),
    resolveQuickstartDefault: vi.fn(() => undefined),
  };
  const mocks = {
    ...agentScope,
    ...setupRegistry,
    ...trustedCatalog,
    ...pluginInstall,
    ...discovery,
    ...configured,
    ...status,
  };
  return {
    ...mocks,
    factories: {
      agentScope: () => agentScope,
      setupRegistry: () => setupRegistry,
      trustedCatalog: () => trustedCatalog,
      pluginInstall: () => pluginInstall,
      configured: () => configured,
      status: () => status,
      discovery: () => ({ ...discovery, shouldShowChannelInSetup: () => true }),
      channels: () => ({
        getChatChannelMeta: (channelId: string) => ({ id: channelId, label: channelId }),
        listChatChannels: () => [],
        normalizeAnyChannelId: normalizeChannel,
        normalizeChatChannelId: normalizeChannel,
      }),
      registry: () => ({
        resolveChannelSetupWizardAdapterForPlugin: (plugin?: { setupWizard?: unknown }) =>
          plugin?.setupWizard,
      }),
      prompts: () => ({
        maybeConfigureCommandOwner: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
        maybeConfigureDmPolicies: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
        promptConfiguredAction: vi.fn(),
        promptRemovalAccountId: vi.fn(),
        formatAccountLabel: vi.fn(),
      }),
    },
    reset(this: void) {
      vi.clearAllMocks();
      for (const mock of Object.values(mocks)) {
        mock.mockReset();
      }
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      mocks.resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    },
  };
}

function normalizeChannel(channelId?: unknown) {
  return typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null;
}
