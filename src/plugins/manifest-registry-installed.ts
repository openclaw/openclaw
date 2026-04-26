import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCandidate } from "./discovery.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import { DEFAULT_PLUGIN_ENTRY_CANDIDATES } from "./manifest.js";

function resolveFallbackPluginSource(record: InstalledPluginIndexRecord): string {
  for (const entry of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
    const candidate = path.join(record.rootDir, entry);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(record.rootDir, DEFAULT_PLUGIN_ENTRY_CANDIDATES[0]);
}

function toPluginCandidate(record: InstalledPluginIndexRecord): PluginCandidate {
  return {
    idHint: record.pluginId,
    source: record.source ?? resolveFallbackPluginSource(record),
    ...(record.setupSource ? { setupSource: record.setupSource } : {}),
    rootDir: record.rootDir,
    origin: record.origin,
    ...(record.packageName ? { packageName: record.packageName } : {}),
    ...(record.packageVersion ? { packageVersion: record.packageVersion } : {}),
    packageDir: record.rootDir,
  };
}

export function loadPluginManifestRegistryForInstalledIndex(params: {
  index: InstalledPluginIndex;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  includeDisabled?: boolean;
}): PluginManifestRegistry {
  if (params.pluginIds && params.pluginIds.length === 0) {
    return { plugins: [], diagnostics: [] };
  }
  const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
  const candidates = params.index.plugins
    .filter((plugin) => params.includeDisabled || plugin.enabled)
    .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId))
    .map(toPluginCandidate);
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: false,
    candidates,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(params.index),
  });
}
