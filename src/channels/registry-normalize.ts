// Channel id normalization through the active plugin registry.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { ChannelId } from "./plugins/channel-id.types.js";
import { findChannelEntryInRegistry, findRegisteredChannelPluginEntry } from "./registry-lookup.js";

/** Normalizes user/config channel identifiers so aliases resolve to canonical channel ids. */
export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return null;
  }
  const scoped = findChannelEntryInRegistry(
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
    key,
  );
  if (scoped) {
    return scoped.plugin.id;
  }
  return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}
