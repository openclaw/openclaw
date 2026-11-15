// Channels plugin-install test helpers build catalog, plugin, and config fixtures for add/remove suites.
import { vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelsConfig } from "../config/types.channels.js";
import { makeCatalogEntry, makeMeta } from "../flows/channel-setup.test-helpers.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";

export function createMockChannelSetupPluginInstallModule(
  actual?: Partial<typeof import("./channel-setup/plugin-install.js")>,
) {
  return {
    ...actual,
    ensureChannelSetupPluginInstalled: vi.fn(async ({ cfg }) => ({ cfg, installed: true })),
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(async () => createTestRegistry()),
  };
}

export function createExternalChatCatalogEntry(): ChannelPluginCatalogEntry {
  return makeCatalogEntry("external-chat", "External Chat", {
    pluginId: "@vendor/external-chat-plugin",
    meta: makeMeta("external-chat", "External Chat", {
      blurb: "external chat channel",
    }),
    install: {
      npmSpec: "@vendor/external-chat",
    },
  });
}

export function createExternalChatSetupPlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "external-chat",
      label: "External Chat",
      docsPath: "/channels/external-chat",
    }),
    setup: {
      applyAccountConfig: vi.fn(({ cfg, input }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          "external-chat": {
            enabled: true,
            token: input.token,
          },
        },
      })),
    },
  } as ChannelPlugin;
}

export function createExternalChatDeletePlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "external-chat",
      label: "External Chat",
      docsPath: "/channels/external-chat",
    }),
    config: {
      ...createChannelTestPluginBase({
        id: "external-chat",
        label: "External Chat",
        docsPath: "/channels/external-chat",
      }).config,
      deleteAccount: vi.fn(({ cfg }: { cfg: Record<string, unknown> }) => {
        const channels = (cfg.channels as Record<string, unknown> | undefined) ?? {};
        const nextChannels = { ...channels };
        delete nextChannels["external-chat"];
        return {
          ...cfg,
          channels: nextChannels as ChannelsConfig,
        };
      }),
    },
  };
}
