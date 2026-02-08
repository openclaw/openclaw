import fs from "node:fs/promises";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginInstallDir } from "./install.js";
import { defaultSlotIdForKey, type PluginSlotKey } from "./slots.js";

export type UninstallActions = {
  entry: boolean;
  install: boolean;
  allowlist: boolean;
  loadPath: boolean;
  memorySlot: boolean;
  directory: boolean;
};

export type UninstallPluginResult =
  | { ok: true; config: OpenClawConfig; pluginId: string; actions: UninstallActions }
  | { ok: false; error: string };

/**
 * Remove plugin references from config (pure config mutation).
 * Returns a new config with the plugin removed from entries, installs, allow, load.paths, and slots.
 */
export function removePluginFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
): { config: OpenClawConfig; actions: Omit<UninstallActions, "directory"> } {
  const actions: Omit<UninstallActions, "directory"> = {
    entry: false,
    install: false,
    allowlist: false,
    loadPath: false,
    memorySlot: false,
  };

  const pluginsConfig = cfg.plugins ?? {};

  // Remove from entries
  let entries = pluginsConfig.entries;
  if (entries && pluginId in entries) {
    const { [pluginId]: _, ...rest } = entries;
    entries = Object.keys(rest).length > 0 ? rest : undefined;
    actions.entry = true;
  }

  // Remove from installs
  let installs = pluginsConfig.installs;
  const installRecord = installs?.[pluginId];
  if (installs && pluginId in installs) {
    const { [pluginId]: _, ...rest } = installs;
    installs = Object.keys(rest).length > 0 ? rest : undefined;
    actions.install = true;
  }

  // Remove from allowlist
  let allow = pluginsConfig.allow;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    allow = allow.filter((id) => id !== pluginId);
    if (allow.length === 0) {
      allow = undefined;
    }
    actions.allowlist = true;
  }

  // Remove linked path from load.paths (for source === "path" plugins)
  let loadPaths = pluginsConfig.load?.paths;
  if (installRecord?.source === "path" && installRecord.sourcePath) {
    const sourcePath = installRecord.sourcePath;
    if (Array.isArray(loadPaths) && loadPaths.includes(sourcePath)) {
      loadPaths = loadPaths.filter((p) => p !== sourcePath);
      if (loadPaths.length === 0) {
        loadPaths = undefined;
      }
      actions.loadPath = true;
    }
  }

  // Reset memory slot if this plugin was selected
  let slots = pluginsConfig.slots;
  if (slots?.memory === pluginId) {
    slots = {
      ...slots,
      memory: defaultSlotIdForKey("memory" as PluginSlotKey),
    };
    actions.memorySlot = true;
  }

  // Build new config with cleaned up plugins section
  const load =
    loadPaths !== undefined ? { ...pluginsConfig.load, paths: loadPaths } : pluginsConfig.load;
  const loadWithoutEmptyPaths =
    load && !load.paths && Object.keys(load).length === 0 ? undefined : load;

  const newPlugins = {
    ...pluginsConfig,
    entries,
    installs,
    allow,
    load: loadWithoutEmptyPaths,
    slots,
  };

  // Clean up undefined properties from newPlugins
  const cleanedPlugins: typeof newPlugins = { ...newPlugins };
  if (cleanedPlugins.entries === undefined) {
    delete cleanedPlugins.entries;
  }
  if (cleanedPlugins.installs === undefined) {
    delete cleanedPlugins.installs;
  }
  if (cleanedPlugins.allow === undefined) {
    delete cleanedPlugins.allow;
  }
  if (cleanedPlugins.load === undefined) {
    delete cleanedPlugins.load;
  }

  const config: OpenClawConfig = {
    ...cfg,
    plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : undefined,
  };

  return { config, actions };
}

export type UninstallPluginParams = {
  config: OpenClawConfig;
  pluginId: string;
  deleteFiles?: boolean;
};

/**
 * Uninstall a plugin by removing it from config and optionally deleting installed files.
 * Linked plugins (source === "path") never have their source directory deleted.
 */
export async function uninstallPlugin(
  params: UninstallPluginParams,
): Promise<UninstallPluginResult> {
  const { config, pluginId, deleteFiles = true } = params;

  // Validate plugin exists
  const hasEntry = pluginId in (config.plugins?.entries ?? {});
  const hasInstall = pluginId in (config.plugins?.installs ?? {});

  if (!hasEntry && !hasInstall) {
    return { ok: false, error: `Plugin not found: ${pluginId}` };
  }

  const installRecord = config.plugins?.installs?.[pluginId];
  const isLinked = installRecord?.source === "path";

  // Remove from config
  const { config: newConfig, actions: configActions } = removePluginFromConfig(config, pluginId);

  const actions: UninstallActions = {
    ...configActions,
    directory: false,
  };

  // Delete installed directory if requested and not a linked plugin
  if (deleteFiles && !isLinked && installRecord?.installPath) {
    try {
      await fs.rm(installRecord.installPath, { recursive: true, force: true });
      actions.directory = true;
    } catch {
      // Directory deletion failure is not fatal; config is the source of truth
    }
  } else if (deleteFiles && !isLinked && hasInstall) {
    // Fallback to default install location if installPath not recorded
    const defaultPath = resolvePluginInstallDir(pluginId);
    try {
      await fs.rm(defaultPath, { recursive: true, force: true });
      actions.directory = true;
    } catch {
      // Ignore
    }
  }

  return {
    ok: true,
    config: newConfig,
    pluginId,
    actions,
  };
}
