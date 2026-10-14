// Resolves plugin auto-enable preference ordering across candidate plugins.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  readPluginCacheJsonFile,
} from "../plugins/plugin-cache-files.js";
import {
  parseExternalPluginCatalogEntries,
  resolveExternalPluginCatalogPaths,
} from "../plugins/plugin-catalog-source.js";
import { isRecord, resolveUserPath } from "../utils.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Maximum bytes to read from an external catalog file before rejecting it. */
const MAX_EXTERNAL_CATALOG_BYTES = 16 * 1024 * 1024;
const log = createSubsystemLogger("config/plugin-catalog");

function resolveExternalCatalogPreferOver(channelId: string, env: NodeJS.ProcessEnv): string[] {
  for (const rawPath of resolveExternalPluginCatalogPaths({ env })) {
    const resolved = resolveUserPath(rawPath, env);
    if (!pluginCacheExistsSync(resolved)) {
      continue;
    }
    try {
      // Resolve symlinks so a catalog file that points to a regular file
      // keeps working while the bounded regular-file read still rejects
      // directories, FIFOs, and oversized targets.
      const resolvedRealPath = pluginCacheRealpathSync(resolved);
      if (!resolvedRealPath) {
        continue;
      }
      const payload = readPluginCacheJsonFile(resolvedRealPath, {
        maxBytes: MAX_EXTERNAL_CATALOG_BYTES,
      });
      if (!payload.ok) {
        throw payload.error;
      }
      for (const entry of parseExternalPluginCatalogEntries(payload.value)) {
        const channel = isRecord(entry.openclaw) ? entry.openclaw.channel : undefined;
        if (!isRecord(channel) || normalizeOptionalString(channel.id) !== channelId) {
          continue;
        }
        return Array.isArray(channel.preferOver)
          ? channel.preferOver.filter((value): value is string => typeof value === "string")
          : [];
      }
    } catch (err) {
      // Surface oversized catalogs so operators know a configured file was
      // skipped — unlike parse or permission errors which mean the file is
      // genuinely unusable.
      if (err instanceof Error && err.message.startsWith("File exceeds")) {
        log.warn(
          `skipping oversized external catalog file (max ${MAX_EXTERNAL_CATALOG_BYTES} bytes): ${resolved}`,
        );
      }
    }
  }
  return [];
}

function resolvePreferredOverIds(
  candidate: PluginAutoEnableCandidate,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): string[] {
  const channelId =
    candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
  const installedPlugin = registry.plugins.find((record) => record.id === candidate.pluginId);
  const manifestChannelPreferOver = installedPlugin?.channelConfigs?.[channelId]?.preferOver;
  if (manifestChannelPreferOver?.length) {
    return [...manifestChannelPreferOver];
  }
  const installedChannelMeta = installedPlugin?.channelCatalogMeta;
  if (installedChannelMeta?.preferOver?.length) {
    return [...installedChannelMeta.preferOver];
  }
  const builtInChannelId = normalizeChatChannelId(channelId);
  const builtInChannelPreferOver = builtInChannelId
    ? findChatChannelMeta(builtInChannelId)?.preferOver
    : undefined;
  if (builtInChannelPreferOver?.length) {
    return [...builtInChannelPreferOver];
  }
  return resolveExternalCatalogPreferOver(channelId, env);
}

export function shouldSkipPreferredPluginAutoEnable(params: {
  config: OpenClawConfig;
  entry: PluginAutoEnableCandidate;
  configured: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  isPluginDenied: (config: OpenClawConfig, pluginId: string) => boolean;
  isPluginExplicitlyDisabled: (config: OpenClawConfig, pluginId: string) => boolean;
  preferOverCache: Map<string, string[]>;
}): boolean {
  const getPreferredOverIds = (candidate: PluginAutoEnableCandidate): string[] => {
    const cacheKey = `${candidate.pluginId}:${candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId}`;
    const cached = params.preferOverCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const resolved = resolvePreferredOverIds(candidate, params.env, params.registry);
    params.preferOverCache.set(cacheKey, resolved);
    return resolved;
  };

  return params.configured.some(
    (other) =>
      other.pluginId !== params.entry.pluginId &&
      !params.isPluginDenied(params.config, other.pluginId) &&
      !params.isPluginExplicitlyDisabled(params.config, other.pluginId) &&
      getPreferredOverIds(other).includes(params.entry.pluginId),
  );
}
