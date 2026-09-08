/** Active channel plugin registry with bundled fallback. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getBundledChannelPlugin } from "./bundled.js";
import {
  getLoadedChannelPluginById,
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export const listChannelPlugins = (): ChannelPlugin[] => listLoadedChannelPlugins();

/**
 * Returns a loaded channel plugin without falling back to bundled metadata.
 */
export function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginById(id);
}

/**
 * Resolves the active channel implementation together with host-owned provenance.
 */
export function resolveChannelPluginRegistration(id: ChannelId):
  | {
      plugin: ChannelPlugin;
      origin?: string;
      trustedOfficialInstall?: boolean;
      captureReadAuthority?: () => (() => boolean) | undefined;
      resolveChannelRuntime?: NonNullable<
        ReturnType<typeof getLoadedChannelPluginEntryById>
      >["resolveChannelRuntime"];
    }
  | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  // Resolve implementation and provenance together. Loaded overrides win and
  // must never borrow bundled authority from the fallback with the same id.
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedEntry = scopedRegistry
    ? getLoadedChannelPluginEntryById(resolvedId, scopedRegistry)
    : undefined;
  const loadedEntry = scopedEntry ?? getLoadedChannelPluginEntryById(resolvedId);
  if (loadedEntry) {
    const origin = normalizeOptionalString(loadedEntry.origin) ?? undefined;
    // Root fallback stays addressable, but an explicit scope cannot borrow its
    // official delegated-read grant when it does not own that channel.
    const ownsReadAuthority = !scopedRegistry || scopedEntry !== undefined;
    return {
      plugin: loadedEntry.plugin as ChannelPlugin,
      ...(loadedEntry.resolveChannelRuntime
        ? { resolveChannelRuntime: loadedEntry.resolveChannelRuntime }
        : {}),
      ...(origin ? { origin } : {}),
      ...(ownsReadAuthority && loadedEntry.trustedOfficialInstall === true
        ? { trustedOfficialInstall: true }
        : {}),
      ...(ownsReadAuthority && loadedEntry.captureReadAuthority
        ? { captureReadAuthority: loadedEntry.captureReadAuthority }
        : {}),
    };
  }
  const plugin = getBundledChannelPlugin(resolvedId);
  return plugin ? { plugin, origin: "bundled" } : undefined;
}

/**
 * Returns the active channel plugin, with bundled fallback for built-in channels.
 */
export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return resolveChannelPluginRegistration(id)?.plugin;
}

/**
 * Normalizes user-facing channel aliases to canonical channel ids.
 */
export function normalizeChannelId(raw?: string | null): ChannelId | null {
  return normalizeAnyChannelId(raw);
}
