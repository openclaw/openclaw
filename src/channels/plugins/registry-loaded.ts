import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActiveChannelPluginRuntimeShape,
  ActivePluginChannelRegistry,
  ActivePluginChannelRegistration,
} from "../../plugins/channel-registry-state.types.js";
import { CHAT_CHANNEL_ORDER } from "../ids.js";
import { resolveRegisteredChannelPluginLookup } from "../registry-lookup.js";
import type { AnyChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type ChannelPluginView = {
  lookup: ReturnType<typeof resolveRegisteredChannelPluginLookup>;
  sorted: ActiveChannelPluginRuntimeShape[];
};

let cachedChannelPluginView: ChannelPluginView | undefined;

export function compareChannelPlugins(
  a: Pick<ActiveChannelPluginRuntimeShape, "id" | "meta">,
  b: Pick<ActiveChannelPluginRuntimeShape, "id" | "meta">,
): number {
  const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
  const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
  // Explicit plugin order wins; known built-ins keep their product order;
  // unknown extension channels sort after them by id for deterministic lists.
  const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
  const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
  return orderA !== orderB ? orderA - orderB : a.id.localeCompare(b.id);
}

function resolveChannelPlugins(registry?: ActivePluginChannelRegistry): ChannelPluginView {
  const lookup = resolveRegisteredChannelPluginLookup(registry);
  if (cachedChannelPluginView?.lookup === lookup) {
    return cachedChannelPluginView;
  }
  const sorted = [...lookup.byExactId.values()]
    .map((entry) => entry.plugin)
    .toSorted(compareChannelPlugins);

  const view = {
    lookup,
    sorted,
  };
  if (lookup.currentRegistry) {
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
): AnyChannelPlugin[] {
  return resolveChannelPlugins(registry).sorted.slice();
}

export function getLoadedChannelPluginById(
  id: string,
): ActiveChannelPluginRuntimeShape | undefined {
  return getLoadedChannelPluginEntryById(id)?.plugin;
}

/** Returns one loaded channel plugin without triggering bundled discovery. */
export function getLoadedChannelPluginForRead(id: ChannelId): AnyChannelPlugin | undefined {
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
  return resolveRegisteredChannelPluginLookup(registry).byExactId.get(resolvedId);
}
