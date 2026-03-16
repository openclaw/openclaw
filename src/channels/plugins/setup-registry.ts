import { discordSetupPlugin } from "../../../extensions/discord/src/channel.setup.js";
import { googlechatPlugin } from "../../../extensions/googlechat/src/channel.js";
import { imessageSetupPlugin } from "../../../extensions/imessage/src/channel.setup.js";
import { ircPlugin } from "../../../extensions/irc/src/channel.js";
import { lineSetupPlugin } from "../../../extensions/line/src/channel.setup.js";
import { signalSetupPlugin } from "../../../extensions/signal/src/channel.setup.js";
import { slackSetupPlugin } from "../../../extensions/slack/src/channel.setup.js";
import { telegramSetupPlugin } from "../../../extensions/telegram/src/channel.setup.js";
import { whatsappSetupPlugin } from "../../../extensions/whatsapp/src/channel.setup.js";
import {
  getActivePluginRegistryVersion,
  requireActivePluginRegistry,
} from "../../plugins/runtime.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "../registry.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

type CachedChannelSetupPlugins = {
  registryVersion: number;
  sorted: ChannelPlugin[];
  byId: Map<string, ChannelPlugin>;
};

const EMPTY_CHANNEL_SETUP_CACHE: CachedChannelSetupPlugins = {
  registryVersion: -1,
  sorted: [],
  byId: new Map(),
};

let cachedChannelSetupPlugins = EMPTY_CHANNEL_SETUP_CACHE;

const BUNDLED_CHANNEL_SETUP_PLUGINS = [
  telegramSetupPlugin,
  whatsappSetupPlugin,
  discordSetupPlugin,
  ircPlugin,
  googlechatPlugin,
  slackSetupPlugin,
  signalSetupPlugin,
  imessageSetupPlugin,
  lineSetupPlugin,
] as ChannelPlugin[];

function dedupeSetupPlugins(plugins: ChannelPlugin[]): ChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: ChannelPlugin[] = [];
  for (const plugin of plugins) {
    const id = String(plugin.id).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved;
}

function sortChannelSetupPlugins(plugins: ChannelPlugin[]): ChannelPlugin[] {
  return dedupeSetupPlugins(plugins).toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
}

function resolveCachedChannelSetupPlugins(): CachedChannelSetupPlugins {
  const registry = requireActivePluginRegistry();
  const registryVersion = getActivePluginRegistryVersion();
  const cached = cachedChannelSetupPlugins;
  if (cached.registryVersion === registryVersion) {
    return cached;
  }

  const registryPlugins = (registry.channelSetups ?? []).map((entry) => entry.plugin);
  const sorted = sortChannelSetupPlugins(
    registryPlugins.length > 0 ? registryPlugins : BUNDLED_CHANNEL_SETUP_PLUGINS,
  );
  const byId = new Map<string, ChannelPlugin>();
  for (const plugin of sorted) {
    byId.set(plugin.id, plugin);
  }

  const next: CachedChannelSetupPlugins = {
    registryVersion,
    sorted,
    byId,
  };
  cachedChannelSetupPlugins = next;
  return next;
}

export function listChannelSetupPlugins(): ChannelPlugin[] {
  return resolveCachedChannelSetupPlugins().sorted.slice();
}

export function getChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = String(id).trim();
  if (!resolvedId) {
    return undefined;
  }
  return resolveCachedChannelSetupPlugins().byId.get(resolvedId);
}
