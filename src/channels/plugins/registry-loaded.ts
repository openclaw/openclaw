/**
 * Loaded channel plugin registry view.
 *
 * Normalizes and sorts active plugin runtime state for channel registry callers.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";

/**
 * Loaded channel plugin shape after id/meta normalization.
 */
export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
  id: string;
  meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};

/**
 * Loaded channel registry entry with a normalized plugin payload.
 */
export type LoadedChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: LoadedChannelPlugin;
};

type ChannelPluginView = {
  sorted: LoadedChannelPlugin[];
  byId: Map<string, LoadedChannelPlugin>;
  entriesById: Map<string, LoadedChannelPluginEntry>;
};

function coerceLoadedChannelPlugin(
  plugin: ActiveChannelPluginRuntimeShape | null | undefined,
): LoadedChannelPlugin | null {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }
  const id = readLoadedChannelId(plugin);
  if (!id) {
    return null;
  }
  return normalizeLoadedChannelMeta(plugin) ? (plugin as LoadedChannelPlugin) : null;
}

function readLoadedChannelId(plugin: ActiveChannelPluginRuntimeShape): string {
  try {
    return normalizeOptionalString(plugin.id) ?? "";
  } catch {
    return "";
  }
}

function normalizeLoadedChannelMeta(plugin: ActiveChannelPluginRuntimeShape): boolean {
  try {
    if (!plugin.meta || typeof plugin.meta !== "object") {
      // Loaded plugin metadata is optional at the runtime-state boundary, but
      // channel sorting expects an object so normalize it once at read time.
      plugin.meta = {};
    }
    return true;
  } catch {
    return false;
  }
}

function readLoadedChannelOrder(plugin: LoadedChannelPlugin): number | undefined {
  try {
    const order = plugin.meta.order;
    return typeof order === "number" && Number.isFinite(order) ? order : undefined;
  } catch {
    return undefined;
  }
}

function dedupeChannels(channels: LoadedChannelPlugin[]): LoadedChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: LoadedChannelPlugin[] = [];
  for (const plugin of channels) {
    const id = readLoadedChannelId(plugin);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved;
}

function resolveChannelPlugins(): ChannelPluginView {
  const registry = getActivePluginChannelRegistryFromState();

  const channelPlugins: LoadedChannelPlugin[] = [];
  const pluginEntries: LoadedChannelPluginEntry[] = [];
  if (registry && Array.isArray(registry.channels)) {
    for (const entry of registry.channels) {
      const plugin = coerceLoadedChannelPlugin(entry?.plugin);
      if (plugin) {
        channelPlugins.push(plugin);
        pluginEntries.push({ ...entry, plugin });
      }
    }
  }

  const sorted = dedupeChannels(channelPlugins).toSorted((a, b) => {
    const idA = readLoadedChannelId(a);
    const idB = readLoadedChannelId(b);
    const indexA = CHAT_CHANNEL_ORDER.indexOf(idA);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(idB);
    // Explicit plugin order wins; known built-ins keep their product order;
    // unknown extension channels sort after them by id for deterministic lists.
    const orderA = readLoadedChannelOrder(a) ?? (indexA === -1 ? 999 : indexA);
    const orderB = readLoadedChannelOrder(b) ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return idA.localeCompare(idB);
  });
  const byId = new Map<string, LoadedChannelPlugin>();
  const entriesById = new Map<string, LoadedChannelPluginEntry>();
  const unsortedEntriesById = new Map<string, LoadedChannelPluginEntry>();
  for (const entry of pluginEntries) {
    const id = readLoadedChannelId(entry.plugin);
    if (id) {
      unsortedEntriesById.set(id, entry);
    }
  }
  for (const plugin of sorted) {
    const id = readLoadedChannelId(plugin);
    if (!id) {
      continue;
    }
    byId.set(id, plugin);
    const entry = unsortedEntriesById.get(id);
    if (entry) {
      entriesById.set(id, entry);
    }
  }

  return {
    sorted,
    byId,
    entriesById,
  };
}

/**
 * Lists loaded channel plugins in deterministic display/runtime order.
 */
export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveChannelPlugins().sorted.slice();
}

/**
 * Returns a loaded channel plugin by normalized id.
 */
export function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().byId.get(resolvedId);
}

/**
 * Returns the loaded channel registry entry by normalized plugin id.
 */
export function getLoadedChannelPluginEntryById(id: string): LoadedChannelPluginEntry | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().entriesById.get(resolvedId);
}
