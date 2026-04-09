import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { OpenClawConfig } from "./config.js";
import {
  configMayNeedPluginAutoEnable,
  resolveConfiguredPluginAutoEnableCandidates,
  resolvePluginAutoEnableManifestRegistry,
  type PluginAutoEnableCandidate,
} from "./plugin-auto-enable.shared.js";

export function detectPluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableCandidate[] {
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  if (!configMayNeedPluginAutoEnable(config, env)) {
    return [];
  }
  const registry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return resolveConfiguredPluginAutoEnableCandidates({
    config,
    env,
    registry,
  });
}
