// Resolves manifest-declared tool-result middleware owners without loading plugin runtimes.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolResultMiddlewareRuntime } from "./agent-tool-result-middleware-types.js";
import { normalizeAgentToolResultMiddlewareRuntimeIds } from "./agent-tool-result-middleware.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";

type MiddlewareOwnerActivationMode = "enabled" | "loadable";

function canUseMiddlewareOwner(params: {
  record: PluginManifestRecord;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
  activationMode: MiddlewareOwnerActivationMode;
}): boolean {
  if (params.activationMode === "loadable" && params.record.origin === "bundled") {
    return true;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.record.id,
    origin: params.record.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.record),
    activationSource: params.activationSource,
  });
  return (
    activationState.enabled &&
    (params.record.origin === "bundled" || activationState.explicitlyEnabled)
  );
}

export function listAgentToolResultMiddlewareOwnerPluginIds(params: {
  manifestRegistry: PluginManifestRegistry;
  runtime: AgentToolResultMiddlewareRuntime;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
  activationMode?: MiddlewareOwnerActivationMode;
}): string[] {
  const pluginIds: string[] = [];
  for (const record of params.manifestRegistry.plugins) {
    if (
      !canUseMiddlewareOwner({
        record,
        config: params.config,
        pluginsConfig: params.pluginsConfig,
        activationSource: params.activationSource,
        activationMode: params.activationMode ?? "loadable",
      })
    ) {
      continue;
    }
    const runtimes = normalizeAgentToolResultMiddlewareRuntimeIds(
      record.contracts?.agentToolResultMiddleware,
    );
    if (runtimes.includes(params.runtime) && !pluginIds.includes(record.id)) {
      pluginIds.push(record.id);
    }
  }
  return pluginIds;
}

export function hasEnabledAgentToolResultMiddlewareOwnerForRuntime(params: {
  runtime: AgentToolResultMiddlewareRuntime;
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): boolean {
  const config = params.config;
  const activationSourceConfig = params.activationSourceConfig ?? config;
  const pluginsConfig = normalizePluginsConfig(config.plugins);
  const activationSourcePlugins = normalizePluginsConfig(activationSourceConfig.plugins);
  const activationSource = createPluginActivationSource({
    config: activationSourceConfig,
    plugins: activationSourcePlugins,
  });
  const manifestRegistry =
    params.manifestRegistry ??
    loadPluginManifestRegistry({
      config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  return (
    listAgentToolResultMiddlewareOwnerPluginIds({
      manifestRegistry,
      runtime: params.runtime,
      config,
      pluginsConfig,
      activationSource,
      activationMode: "enabled",
    }).length > 0
  );
}
