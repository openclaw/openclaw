import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistry,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import {
  getActivePluginChannelRegistrySnapshotFromState,
  type ActivePluginChannelRegistrySnapshot,
} from "../../plugins/runtime-channel-state.js";
import { CHAT_CHANNEL_ORDER } from "../registry.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type ChannelPluginView = {
  snapshot: ActivePluginChannelRegistrySnapshot;
  sorted: ActiveChannelPluginRuntimeShape[];
  byId: Map<string, ActiveChannelPluginRuntimeShape>;
  entriesById: Map<string, ActivePluginChannelRegistration>;
};

let cachedChannelPluginView: ChannelPluginView | undefined;

function resolveChannelPlugins(registry?: ActivePluginChannelRegistry): ChannelPluginView {
  const snapshot = getActivePluginChannelRegistrySnapshotFromState();
  const currentRegistry = registry === undefined || registry === snapshot.registry;
  if (currentRegistry && cachedChannelPluginView?.snapshot === snapshot) {
    return cachedChannelPluginView;
  }
  const selectedRegistry = registry ?? snapshot.registry;

  const seen = new Set<string>();
  const byId = new Map<string, ActiveChannelPluginRuntimeShape>();
  const entriesById = new Map<string, ActivePluginChannelRegistration>();
  if (selectedRegistry && Array.isArray(selectedRegistry.channels)) {
    for (const entry of selectedRegistry.channels) {
      const plugin = entry?.plugin;
      const id = normalizeOptionalString(plugin?.id);
      if (!plugin || !id || seen.has(id)) {
        continue;
      }
      // Channel registration is first-wins. Keep its implementation and
      // provenance together so a colliding plugin cannot borrow its authority.
      seen.add(id);
      byId.set(plugin.id, plugin);
      entriesById.set(plugin.id, { ...entry, plugin });
    }
  }

  const sorted = [...byId.values()].toSorted((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
    // Explicit plugin order wins; known built-ins keep their product order;
    // unknown extension channels sort after them by id for deterministic lists.
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });

  const view = {
    snapshot: currentRegistry ? snapshot : { registry: selectedRegistry, version: 0 },
    sorted,
    byId,
    entriesById,
  };
  if (currentRegistry) {
    // Runtime snapshots invalidate the single process-root registry view.
    cachedChannelPluginView = view;
  }
  return view;
}

export function listLoadedChannelPlugins(): ActiveChannelPluginRuntimeShape[] {
  return resolveChannelPlugins().sorted.slice();
}

/** Lists one exact registry without substituting a pinned or active registry. */
export function listLoadedChannelPluginsForRegistry(
  registry: ActivePluginChannelRegistry,
): ChannelPlugin[] {
  return resolveChannelPlugins(registry).sorted.slice();
}

export function getLoadedChannelPluginById(
  id: string,
): ActiveChannelPluginRuntimeShape | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins().byId.get(resolvedId);
}

/** Returns one loaded channel plugin without triggering bundled discovery. */
export function getLoadedChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginById(id);
}

export function getLoadedChannelPluginEntryById(
  id: string,
  registry?: ActivePluginChannelRegistry,
): ActivePluginChannelRegistration | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return resolveChannelPlugins(registry).entriesById.get(resolvedId);
}
