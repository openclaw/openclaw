import {
  getActivePluginChannelRegistryVersion,
  requireActivePluginChannelRegistry,
} from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId, normalizeAnyChannelId } from "../registry.js";
import { getBundledChannelPlugin } from "./bundled.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

function dedupeChannels(channels: ChannelPlugin[]): ChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: ChannelPlugin[] = [];
  for (const plugin of channels) {
    const id = normalizeOptionalString(plugin.id) ?? "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved;
}

type CachedChannelPlugins = {
  registryVersion: number;
  registryRef: object | null;
  sorted: ChannelPlugin[];
  byId: Map<string, ChannelPlugin>;
};

const EMPTY_CHANNEL_PLUGIN_CACHE: CachedChannelPlugins = {
  registryVersion: -1,
  registryRef: null,
  sorted: [],
  byId: new Map(),
};

let cachedChannelPlugins = EMPTY_CHANNEL_PLUGIN_CACHE;

function resolveCachedChannelPlugins(): CachedChannelPlugins {
  const registry = requireActivePluginChannelRegistry();
  const registryVersion = getActivePluginChannelRegistryVersion();
  const cached = cachedChannelPlugins;
  if (cached.registryVersion === registryVersion && cached.registryRef === registry) {
    return cached;
  }

  const channelPlugins: ChannelPlugin[] = [];
  if (Array.isArray(registry.channels)) {
    for (const entry of registry.channels) {
      if (entry?.plugin) {
        channelPlugins.push(entry.plugin);
      }
    }
  }

  const sorted = dedupeChannels(channelPlugins).toSorted((a, b) => {
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

  const next: CachedChannelPlugins = {
    registryVersion,
    registryRef: registry,
    sorted,
    byId,
  };
  cachedChannelPlugins = next;
  return next;
}

export function listChannelPlugins(): ChannelPlugin[] {
  return resolveCachedChannelPlugins().sorted.slice();
}

export function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveCachedChannelPlugins().byId.get(resolvedId);
}

export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPlugin(resolvedId) ?? getBundledChannelPlugin(resolvedId);
}

export function normalizeChannelId(raw?: string | null): ChannelId | null {
  return normalizeAnyChannelId(raw);
}
