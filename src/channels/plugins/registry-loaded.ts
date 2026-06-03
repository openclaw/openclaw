import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";

export type LoadedChannelPlugin = ActiveChannelPluginRuntimeShape & {
  id: string;
  meta: NonNullable<ActiveChannelPluginRuntimeShape["meta"]>;
};

export type LoadedChannelPluginEntry = ActivePluginChannelRegistration & {
  plugin: LoadedChannelPlugin;
};

type ChannelPluginView = {
  sorted: LoadedChannelPlugin[];
  byId: Map<string, LoadedChannelPlugin>;
  entriesById: Map<string, LoadedChannelPluginEntry>;
};

const stableLoadedChannelPlugins = new WeakMap<
  ActiveChannelPluginRuntimeShape,
  LoadedChannelPlugin
>();

function hasAccessorDescriptor(descriptor: PropertyDescriptor | undefined): boolean {
  return Boolean(descriptor && ("get" in descriptor || "set" in descriptor));
}

function readLoadedChannelPluginId(plugin: ActiveChannelPluginRuntimeShape): string {
  try {
    return normalizeOptionalString(plugin.id) ?? "";
  } catch {
    return "";
  }
}

function readLoadedChannelPluginMeta(plugin: ActiveChannelPluginRuntimeShape): {
  meta: LoadedChannelPlugin["meta"];
  valid: boolean;
} {
  try {
    const meta = plugin.meta;
    if (meta && typeof meta === "object") {
      return { meta: meta as LoadedChannelPlugin["meta"], valid: true };
    }
  } catch {
    // Fall through to empty metadata.
  }
  return { meta: {}, valid: false };
}

function stableLoadedChannelPlugin(params: {
  plugin: ActiveChannelPluginRuntimeShape;
  id: string;
  meta: LoadedChannelPlugin["meta"];
}): LoadedChannelPlugin {
  const plugin = Object.create(Object.getPrototypeOf(params.plugin)) as LoadedChannelPlugin;
  const descriptors = Object.getOwnPropertyDescriptors(params.plugin);
  delete descriptors.id;
  delete descriptors.meta;
  Object.defineProperties(plugin, descriptors);
  Object.defineProperties(plugin, {
    id: {
      value: params.id,
      enumerable: true,
      configurable: true,
    },
    meta: {
      value: params.meta,
      enumerable: true,
      configurable: true,
    },
  });
  return plugin;
}

export function coerceLoadedChannelPlugin(
  plugin: ActiveChannelPluginRuntimeShape | null | undefined,
): LoadedChannelPlugin | null {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }
  const idDescriptor = Object.getOwnPropertyDescriptor(plugin, "id");
  const metaDescriptor = Object.getOwnPropertyDescriptor(plugin, "meta");
  const needsStableWrapper =
    hasAccessorDescriptor(idDescriptor) || hasAccessorDescriptor(metaDescriptor);
  if (needsStableWrapper) {
    const cached = stableLoadedChannelPlugins.get(plugin);
    if (cached) {
      return cached;
    }
  }
  const id = readLoadedChannelPluginId(plugin);
  if (!id) {
    return null;
  }
  const meta = readLoadedChannelPluginMeta(plugin);
  if (!needsStableWrapper && meta.valid) {
    return plugin as LoadedChannelPlugin;
  }
  if (!needsStableWrapper) {
    try {
      plugin.meta = meta.meta;
      return plugin as LoadedChannelPlugin;
    } catch {
      // Fall through to a stable wrapper when malformed metadata is read-only.
    }
  }
  const cached = stableLoadedChannelPlugins.get(plugin);
  if (cached) {
    return cached;
  }
  const stable = stableLoadedChannelPlugin({
    plugin,
    id,
    meta: meta.meta,
  });
  stableLoadedChannelPlugins.set(plugin, stable);
  return stable;
}

function dedupeChannels(channels: LoadedChannelPlugin[]): LoadedChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: LoadedChannelPlugin[] = [];
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
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
  const byId = new Map<string, LoadedChannelPlugin>();
  const entriesById = new Map<string, LoadedChannelPluginEntry>();
  const unsortedEntriesById = new Map(pluginEntries.map((entry) => [entry.plugin.id, entry]));
  for (const plugin of sorted) {
    byId.set(plugin.id, plugin);
    const entry = unsortedEntriesById.get(plugin.id);
    if (entry) {
      entriesById.set(plugin.id, entry);
    }
  }

  return {
    sorted,
    byId,
    entriesById,
  };
}

export function listLoadedChannelPlugins(): LoadedChannelPlugin[] {
  return resolveChannelPlugins().sorted.slice();
}

export function getLoadedChannelPluginById(id: string): LoadedChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().byId.get(resolvedId);
}

export function getLoadedChannelPluginEntryById(id: string): LoadedChannelPluginEntry | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().entriesById.get(resolvedId);
}
