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

function resolveCachedChannelSetupPlugins(): CachedChannelSetupPlugins {
  const registry = requireActivePluginRegistry();
  const registryVersion = getActivePluginRegistryVersion();
  const cached = cachedChannelSetupPlugins;
  if (cached.registryVersion === registryVersion) {
    return cached;
  }

  const sorted = dedupeSetupPlugins(
    (registry.channelSetups ?? []).map((entry) => entry.plugin),
  ).toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
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
