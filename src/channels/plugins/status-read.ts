import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { ensurePluginRegistryLoaded } from "../../plugins/runtime/runtime-registry-loader.js";
import { listPotentialConfiguredChannelIds } from "../config-presence.js";
import { getBootstrapChannelPlugin } from "./bootstrap-registry.js";
import { getLoadedChannelPluginById, listLoadedChannelPlugins } from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";

type StatusChannelPluginParams = {
  cfg: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function resolveConfiguredStatusChannelIds(params: StatusChannelPluginParams): readonly string[] {
  const env = params.env ?? process.env;
  const configured = listPotentialConfiguredChannelIds(params.cfg, env, {
    includePersistedAuthState: false,
  });
  if (configured.length > 0) {
    return configured;
  }
  return listPotentialConfiguredChannelIds(params.cfg, env);
}

function collectReadableStatusChannelPluginsByIds(ids: readonly string[]): {
  plugins: ChannelPlugin[];
  missingIds: string[];
} {
  const plugins: ChannelPlugin[] = [];
  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const plugin =
      (getLoadedChannelPluginById(id) as ChannelPlugin | undefined) ??
      getBootstrapChannelPlugin(id);
    if (plugin) {
      plugins.push(plugin);
      continue;
    }
    missingIds.push(id);
  }
  return { plugins, missingIds };
}

export function listStatusChannelPlugins(params: StatusChannelPluginParams): ChannelPlugin[] {
  const loadedPlugins = listLoadedChannelPlugins() as ChannelPlugin[];
  if (loadedPlugins.length > 0) {
    return loadedPlugins;
  }

  const configuredChannelIds = resolveConfiguredStatusChannelIds(params);
  if (configuredChannelIds.length === 0) {
    return [];
  }

  const initial = collectReadableStatusChannelPluginsByIds(configuredChannelIds);
  if (initial.missingIds.length === 0) {
    return initial.plugins;
  }

  const scopedPluginIds = resolveScopedChannelPluginIds({
    config: params.cfg,
    activationSourceConfig: params.sourceConfig ?? params.cfg,
    channelIds: initial.missingIds,
    env: params.env ?? process.env,
  });
  if (scopedPluginIds.length === 0) {
    return initial.plugins;
  }

  // Fall back to runtime registry loading only when a configured channel cannot
  // be satisfied by the bundled/read-only fast path.
  ensurePluginRegistryLoaded({
    scope: "configured-channels",
    config: params.cfg,
    activationSourceConfig: params.sourceConfig ?? params.cfg,
    onlyPluginIds: scopedPluginIds,
  });

  return [
    ...initial.plugins,
    ...collectReadableStatusChannelPluginsByIds(scopedPluginIds).plugins.filter(
      (plugin) => !initial.plugins.some((existing) => existing.id === plugin.id),
    ),
  ];
}
