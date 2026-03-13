import path from "node:path";
import { normalizeChatChannelId } from "../channels/registry.js";
import { resolveBundledPluginSources } from "../plugins/bundled-sources.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import type { OpenClawConfig } from "./types.js";

export const LEGACY_REMOVED_PLUGIN_IDS = new Set(["google-antigravity-auth"]);

type PluginRepairResult = {
  config: OpenClawConfig;
  changes: string[];
};

type PluginLoadLike = Record<string, unknown> | undefined;

function pathsEqual(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

function cleanupPluginLoadShape(load: PluginLoadLike) {
  if (!load || typeof load !== "object" || Array.isArray(load)) {
    return undefined;
  }
  const nextLoad = { ...load };
  const paths = Array.isArray(nextLoad.paths) ? nextLoad.paths : undefined;
  if (!paths || paths.length === 0) {
    delete nextLoad.paths;
  }
  return Object.keys(nextLoad).length > 0 ? nextLoad : undefined;
}

function cleanupPluginsShape(config: OpenClawConfig): OpenClawConfig {
  const plugins = config.plugins;
  if (!plugins) {
    return config;
  }

  const nextPlugins = { ...plugins };

  if (!nextPlugins.allow || nextPlugins.allow.length === 0) {
    delete nextPlugins.allow;
  }
  if (!nextPlugins.deny || nextPlugins.deny.length === 0) {
    delete nextPlugins.deny;
  }
  if (!nextPlugins.entries || Object.keys(nextPlugins.entries).length === 0) {
    delete nextPlugins.entries;
  }
  if (!nextPlugins.installs || Object.keys(nextPlugins.installs).length === 0) {
    delete nextPlugins.installs;
  }
  const cleanedLoad = cleanupPluginLoadShape(nextPlugins.load);
  if (!cleanedLoad) {
    delete nextPlugins.load;
  } else {
    nextPlugins.load = cleanedLoad as typeof nextPlugins.load;
  }
  if (!nextPlugins.slots || Object.keys(nextPlugins.slots).length === 0) {
    delete nextPlugins.slots;
  }

  if (Object.keys(nextPlugins).length === 0) {
    return { ...config, plugins: undefined };
  }
  return { ...config, plugins: nextPlugins };
}

function resolveLoadPathPluginId(loadPath: string): string | null {
  const manifest = loadPluginManifest(loadPath, false);
  if (manifest.ok) {
    return manifest.manifest.id;
  }
  return null;
}

function findBundledLoadPathPluginId(
  loadPath: string,
  bundled: ReadonlyMap<string, { localPath: string }>,
): string | null {
  for (const [pluginId, bundledInfo] of bundled.entries()) {
    if (pathsEqual(loadPath, bundledInfo.localPath)) {
      return pluginId;
    }
  }
  return null;
}

function isRedundantBundledChannelEnable(cfg: OpenClawConfig, pluginId: string): boolean {
  const channelId = normalizeChatChannelId(pluginId);
  if (!channelId) {
    return false;
  }
  const channel = cfg.channels?.[channelId];
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    return false;
  }
  return (channel as Record<string, unknown>).enabled === true;
}

export function repairPluginConfigNoise(cfg: OpenClawConfig): PluginRepairResult {
  if (!cfg.plugins) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const plugins = next.plugins;
  if (!plugins) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  const bundled = resolveBundledPluginSources({});
  const entries = { ...plugins.entries };
  const installs = { ...plugins.installs };
  const allow = [...(plugins.allow ?? [])];
  const deny = [...(plugins.deny ?? [])];
  const loadPaths = [...(plugins.load?.paths ?? [])];
  const slots = plugins.slots ? { ...plugins.slots } : undefined;

  for (const removedId of LEGACY_REMOVED_PLUGIN_IDS) {
    if (removedId in entries) {
      delete entries[removedId];
      changes.push(`- Removed plugins.entries.${removedId}`);
    }
    if (removedId in installs) {
      delete installs[removedId];
      changes.push(`- Removed plugins.installs.${removedId}`);
    }
  }

  const filteredAllow = allow.filter((pluginId) => {
    const keep = !LEGACY_REMOVED_PLUGIN_IDS.has(pluginId);
    if (!keep) {
      changes.push(`- Removed plugins.allow entry "${pluginId}"`);
    }
    return keep;
  });

  const filteredDeny = deny.filter((pluginId) => {
    const keep = !LEGACY_REMOVED_PLUGIN_IDS.has(pluginId);
    if (!keep) {
      changes.push(`- Removed plugins.deny entry "${pluginId}"`);
    }
    return keep;
  });

  const filteredLoadPaths = loadPaths.filter((loadPath) => {
    const bundledPluginId = findBundledLoadPathPluginId(loadPath, bundled);
    if (bundledPluginId) {
      changes.push(`- Removed plugins.load.paths override for bundled plugin "${bundledPluginId}"`);
      return false;
    }

    const pluginId = resolveLoadPathPluginId(loadPath);
    if (pluginId && LEGACY_REMOVED_PLUGIN_IDS.has(pluginId)) {
      changes.push(`- Removed plugins.load.paths entry for removed plugin "${pluginId}"`);
      return false;
    }
    return true;
  });

  for (const [pluginId, installRecord] of Object.entries(installs)) {
    const bundledInfo = bundled.get(pluginId);
    if (
      installRecord?.source === "path" &&
      bundledInfo &&
      pathsEqual(installRecord.sourcePath, bundledInfo.localPath)
    ) {
      delete installs[pluginId];
      changes.push(`- Removed plugins.installs.${pluginId} bundled path override`);
    }
  }

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (
      bundled.has(pluginId) &&
      entry?.enabled === true &&
      Object.keys(entry).length === 1 &&
      isRedundantBundledChannelEnable(next, pluginId)
    ) {
      delete entries[pluginId];
      changes.push(`- Removed redundant plugins.entries.${pluginId}.enabled=true override`);
    }
  }

  if (slots?.memory && LEGACY_REMOVED_PLUGIN_IDS.has(slots.memory)) {
    const removedSlotId = slots.memory;
    slots.memory = defaultSlotIdForKey("memory");
    changes.push(
      `- Reset plugins.slots.memory from removed plugin "${removedSlotId}" to "${slots.memory}"`,
    );
  }
  if (slots?.contextEngine && LEGACY_REMOVED_PLUGIN_IDS.has(slots.contextEngine)) {
    const removedSlotId = slots.contextEngine;
    slots.contextEngine = defaultSlotIdForKey("contextEngine");
    changes.push(
      `- Reset plugins.slots.contextEngine from removed plugin "${removedSlotId}" to "${slots.contextEngine}"`,
    );
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }

  const repairedLoadInput = {
    ...(plugins.load ? (plugins.load as Record<string, unknown>) : {}),
  };
  if (filteredLoadPaths.length > 0) {
    repairedLoadInput.paths = filteredLoadPaths;
  } else {
    delete repairedLoadInput.paths;
  }
  const repairedLoad = cleanupPluginLoadShape(repairedLoadInput);

  next.plugins = {
    ...(typeof plugins.enabled === "boolean" ? { enabled: plugins.enabled } : {}),
    ...(filteredAllow.length > 0 ? { allow: filteredAllow } : {}),
    ...(filteredDeny.length > 0 ? { deny: filteredDeny } : {}),
    ...(repairedLoad ? { load: repairedLoad as typeof plugins.load } : {}),
    ...(slots ? { slots } : {}),
    ...(Object.keys(entries).length > 0 ? { entries } : {}),
    ...(Object.keys(installs).length > 0 ? { installs } : {}),
  };

  return {
    config: cleanupPluginsShape(next),
    changes,
  };
}
