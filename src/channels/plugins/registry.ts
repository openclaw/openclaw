import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAnyChannelId } from "../registry.js";
import { getBundledChannelPlugin } from "./bundled.js";
import {
  getLoadedChannelPluginById,
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

/** Lists loaded channel plugins in display/selection order. */
export function listChannelPlugins(): ChannelPlugin[] {
  return listLoadedChannelPlugins() as ChannelPlugin[];
}

/** Looks up a loaded channel plugin without falling back to bundled plugin metadata. */
export function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPluginById(resolvedId) as ChannelPlugin | undefined;
}

/** Resolves the registry origin for a loaded channel plugin. */
export function getLoadedChannelPluginOrigin(id: ChannelId): string | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return normalizeOptionalString(getLoadedChannelPluginEntryById(resolvedId)?.origin) ?? undefined;
}

/** Looks up a channel plugin, falling back to bundled metadata before registry bootstrap. */
export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  return getLoadedChannelPlugin(resolvedId) ?? getBundledChannelPlugin(resolvedId);
}

/** Normalizes user-facing channel aliases and ids into canonical channel ids. */
export function normalizeChannelId(raw?: string | null): ChannelId | null {
  return normalizeAnyChannelId(raw);
}
