import { afterEach, beforeEach } from "vitest";
import { normalizeWhatsAppAllowFromEntries } from "../../channels/plugins/normalize/whatsapp.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

function formatDiscordAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^(discord|user|pk):/i, "").replace(/^<@!?(\d+)>$/, "$1"))
    .map((entry) => entry.toLowerCase());
}

function resolveChannelAllowFrom(
  cfg: Record<string, unknown>,
  channelId: string,
): Array<string | number> | undefined {
  const channels =
    cfg.channels && typeof cfg.channels === "object"
      ? (cfg.channels as Record<string, unknown>)
      : undefined;
  const channel =
    channels?.[channelId] && typeof channels[channelId] === "object"
      ? (channels[channelId] as Record<string, unknown>)
      : undefined;
  const allowFrom = channel?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : undefined;
}

export const createCommandAuthRegistry = () =>
  createTestRegistry([
    {
      pluginId: "discord",
      plugin: {
        ...createOutboundTestPlugin({ id: "discord", outbound: { deliveryMode: "direct" } }),
        config: {
          listAccountIds: () => [],
          resolveAllowFrom: ({ cfg }: { cfg: Record<string, unknown> }) =>
            resolveChannelAllowFrom(cfg, "discord"),
          formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
            formatDiscordAllowFromEntries(allowFrom),
        },
      },
      source: "test",
    },
    {
      pluginId: "whatsapp",
      plugin: {
        ...createOutboundTestPlugin({ id: "whatsapp", outbound: { deliveryMode: "direct" } }),
        config: {
          listAccountIds: () => [],
          resolveAllowFrom: ({ cfg }: { cfg: Record<string, unknown> }) =>
            resolveChannelAllowFrom(cfg, "whatsapp"),
          formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
            normalizeWhatsAppAllowFromEntries(allowFrom),
        },
      },
      source: "test",
    },
  ]);

export function installDiscordRegistryHooks() {
  beforeEach(() => {
    setActivePluginRegistry(createCommandAuthRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createCommandAuthRegistry());
  });
}
