import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";

const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn((_cfg?: unknown) => "default"));
const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((_args?: unknown): unknown[] => []));
const getChannelPluginCatalogEntry = vi.hoisted(() =>
  vi.fn((_channel?: unknown, _args?: unknown): unknown => undefined),
);
const isTrustedWorkspaceChannelCatalogEntry = vi.hoisted(() =>
  vi.fn((_entry?: unknown, _cfg?: unknown) => true),
);
const getChannelSetupPlugin = vi.hoisted(() => vi.fn((_channel?: unknown) => undefined));
const listChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadChannelSetupPluginRegistrySnapshotForChannel = vi.hoisted(() =>
  vi.fn((_args?: unknown) => ({
    channels: [],
    channelSetups: [],
  })),
);
const isChannelConfigured = vi.hoisted(() => vi.fn((_cfg?: unknown, _channel?: unknown) => false));
const collectChannelStatus = vi.hoisted(() =>
  vi.fn(async (_args?: unknown) => ({
    installedPlugins: [],
    catalogEntries: [],
    installedCatalogEntries: [],
    statusByChannel: new Map(),
    statusLines: [],
  })),
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (cfg?: unknown, agentId?: unknown) =>
    resolveAgentWorkspaceDir(cfg, agentId),
  resolveDefaultAgentId: (cfg?: unknown) => resolveDefaultAgentId(cfg),
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: (channel?: unknown, args?: unknown) =>
    getChannelPluginCatalogEntry(channel, args),
  listChannelPluginCatalogEntries: (args?: unknown) => listChannelPluginCatalogEntries(args),
}));

vi.mock("../channels/plugins/setup-registry.js", () => ({
  getChannelSetupPlugin: (channel?: unknown) => getChannelSetupPlugin(channel),
  listChannelSetupPlugins: () => listChannelSetupPlugins(),
}));

vi.mock("../channels/registry.js", () => ({
  listChatChannels: () => [],
}));

vi.mock("../commands/channel-setup/registry.js", () => ({
  resolveChannelSetupWizardAdapterForPlugin: vi.fn(),
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: (args?: unknown) =>
    loadChannelSetupPluginRegistrySnapshotForChannel(args),
}));

vi.mock("../commands/channel-setup/workspace-trust.js", () => ({
  isTrustedWorkspaceChannelCatalogEntry: (entry?: unknown, cfg?: unknown) =>
    isTrustedWorkspaceChannelCatalogEntry(entry, cfg),
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (cfg?: unknown, channel?: unknown) => isChannelConfigured(cfg, channel),
}));

vi.mock("./channel-setup.status.js", () => ({
  collectChannelStatus: (args?: unknown) => collectChannelStatus(args),
  noteChannelPrimer: vi.fn(),
  resolveChannelSelectionNoteLines: vi.fn(() => []),
  resolveChannelSetupSelectionContributions: vi.fn(() => []),
  resolveQuickstartDefault: vi.fn(() => undefined),
  noteChannelStatus: vi.fn(),
}));

import { setupChannels } from "./channel-setup.js";

describe("setupChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listChannelPluginCatalogEntries.mockReturnValue([]);
    getChannelPluginCatalogEntry.mockReturnValue(undefined);
    isTrustedWorkspaceChannelCatalogEntry.mockReturnValue(true);
    isChannelConfigured.mockReturnValue(false);
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: [],
    });
  });

  it("queries the full catalog (including trusted workspace entries) while preloading scoped setup plugins", async () => {
    const prompter = {
      confirm: vi.fn(async () => false),
      note: vi.fn(async () => {}),
    } as unknown as WizardPrompter;

    await setupChannels({} as never, {} as never, prompter, {});

    // Preload uses the full catalog; workspace trust filtering is applied per-entry
    // rather than via excludeWorkspace so trusted workspace channels remain discoverable.
    expect(listChannelPluginCatalogEntries).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("skips untrusted workspace catalog entries during preload", async () => {
    const untrustedEntry = {
      id: "matrix",
      origin: "workspace",
      pluginId: "malicious-plugin",
      meta: {},
    };
    const bundledFallbackEntry = {
      id: "matrix",
      origin: "bundled",
      pluginId: "matrix",
      meta: {},
    };
    listChannelPluginCatalogEntries.mockReturnValue([untrustedEntry]);
    isTrustedWorkspaceChannelCatalogEntry.mockReturnValue(false);
    getChannelPluginCatalogEntry.mockReturnValue(bundledFallbackEntry);
    isChannelConfigured.mockReturnValue(true);

    const prompter = {
      confirm: vi.fn(async () => false),
      note: vi.fn(async () => {}),
    } as unknown as WizardPrompter;

    await setupChannels({} as never, {} as never, prompter, {});

    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("matrix", {
      workspaceDir: "/tmp/openclaw-workspace",
      excludeWorkspace: true,
    });
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith({
      cfg: {},
      runtime: {},
      channel: "matrix",
      pluginId: "matrix",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });
});
