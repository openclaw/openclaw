import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
  listChannelPluginCatalogEntries: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  getChannelPlugin: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  createClackPrompter: vi.fn(() => ({}) as never),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: unknown) => (typeof value === "string" ? value.trim() || null : null),
}));

vi.mock("./plugin-install.js", () => ({
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

import { resolveInstallableChannelPlugin } from "./channel-plugin-resolution.js";

function createCatalogEntry(params: {
  id: string;
  pluginId: string;
  origin?: "workspace" | "bundled";
}): ChannelPluginCatalogEntry {
  return {
    id: params.id,
    pluginId: params.pluginId,
    origin: params.origin,
    meta: {
      id: params.id,
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram channel",
    },
    install: {
      npmSpec: params.pluginId,
    },
  };
}

function createPlugin(id: string): ChannelPlugin {
  return { id } as ChannelPlugin;
}

describe("resolveInstallableChannelPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: {},
      installed: false,
    });
  });

  it("ignores untrusted workspace channel shadows during setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const bundledEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "telegram",
      origin: "bundled",
    });
    const bundledPlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockImplementation(
      ({ excludeWorkspace }: { excludeWorkspace?: boolean }) =>
        excludeWorkspace ? [bundledEntry] : [workspaceEntry],
    );
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "telegram" ? [{ plugin: bundledPlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("telegram");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "telegram",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("keeps trusted workspace channel plugins eligible for setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const workspacePlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "evil-telegram-shadow" ? [{ plugin: workspacePlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["evil-telegram-shadow"],
        },
      },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("evil-telegram-shadow");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "evil-telegram-shadow",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });
});
