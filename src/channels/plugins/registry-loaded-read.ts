import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { coerceLoadedChannelPlugin } from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export function getLoadedChannelPluginForRead(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  const registry = getActivePluginChannelRegistryFromState();
  if (!registry || !Array.isArray(registry.channels)) {
    return undefined;
  }
  for (const entry of registry.channels) {
    const plugin = coerceLoadedChannelPlugin(entry?.plugin);
    if (plugin && plugin.id === resolvedId) {
      return plugin;
    }
  }
  return undefined;
}
