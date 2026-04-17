import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntriesUnfiltered,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEnableState } from "../../plugins/config-state.js";

function resolveEffectiveTrustConfig(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): OpenClawConfig {
  return applyPluginAutoEnable({
    config: cfg,
    env: env ?? process.env,
  }).config;
}

function isTrustedWorkspaceChannelCatalogEntry(
  entry: ChannelPluginCatalogEntry | undefined,
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (entry?.origin !== "workspace") {
    return true;
  }
  if (!entry.pluginId) {
    return false;
  }
  const effectiveConfig = resolveEffectiveTrustConfig(cfg, env);
  return resolveEnableState(
    entry.pluginId,
    "workspace",
    normalizePluginsConfig(effectiveConfig.plugins),
  ).enabled;
}

export function getTrustedChannelPluginCatalogEntry(
  channelId: string,
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): ChannelPluginCatalogEntry | undefined {
  const candidate = getChannelPluginCatalogEntry(channelId, {
    workspaceDir: params.workspaceDir,
  });
  if (isTrustedWorkspaceChannelCatalogEntry(candidate, params.cfg, params.env)) {
    return candidate;
  }
  return getChannelPluginCatalogEntry(channelId, {
    workspaceDir: params.workspaceDir,
    excludeWorkspace: true,
  });
}

/**
 * Trusted catalog listing — the recommended entry point for all execution-facing
 * paths (channels add, setup, onboard, scoped load). Untrusted workspace shadows
 * are replaced by their bundled fallback; untrusted workspace-only entries
 * (no bundled fallback) are dropped entirely.
 */
export function listTrustedChannelPluginCatalogEntries(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[] {
  const unfiltered = listChannelPluginCatalogEntriesUnfiltered({
    workspaceDir: params.workspaceDir,
  });
  const fallbackById = new Map(
    listChannelPluginCatalogEntriesUnfiltered({
      workspaceDir: params.workspaceDir,
      excludeWorkspace: true,
    }).map((entry) => [entry.id, entry]),
  );
  return unfiltered.flatMap((entry) => {
    if (isTrustedWorkspaceChannelCatalogEntry(entry, params.cfg, params.env)) {
      return [entry];
    }
    const fallback = fallbackById.get(entry.id);
    return fallback ? [fallback] : [];
  });
}

/**
 * Lenient catalog listing for UI discovery only. Keeps untrusted workspace-only
 * entries (no bundled fallback) so they remain visible in setup wizard
 * selection menus. **Do not use for execution-facing paths** (channels add,
 * scoped load, gateway) — use {@link listTrustedChannelPluginCatalogEntries}
 * instead, which drops untrusted workspace-only entries entirely.
 */
export function listSetupDiscoveryChannelPluginCatalogEntries(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[] {
  const unfiltered = listChannelPluginCatalogEntriesUnfiltered({
    workspaceDir: params.workspaceDir,
  });
  const fallbackById = new Map(
    listChannelPluginCatalogEntriesUnfiltered({
      workspaceDir: params.workspaceDir,
      excludeWorkspace: true,
    }).map((entry) => [entry.id, entry]),
  );
  return unfiltered.flatMap((entry) => {
    if (isTrustedWorkspaceChannelCatalogEntry(entry, params.cfg, params.env)) {
      return [entry];
    }
    const fallback = fallbackById.get(entry.id);
    return fallback ? [fallback] : [entry];
  });
}
