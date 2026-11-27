import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolveConfiguredPluginAutoEnableCandidates,
  resolvePluginAutoEnableReadiness,
  resolvePluginAutoEnableManifestRegistry,
} from "./plugin-auto-enable.shared.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Detects installed plugins that should become enabled from existing config usage. */
export function detectPluginAutoEnableCandidates(
  params: Parameters<typeof detectPluginAutoEnableCandidatesWithRegistry>[0],
): PluginAutoEnableCandidate[] {
  return detectPluginAutoEnableCandidatesWithRegistry(params).candidates;
}

/** Keep detection and materialization on one registry within a synchronous apply. */
export function detectPluginAutoEnableCandidatesWithRegistry(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): { candidates: PluginAutoEnableCandidate[]; manifestRegistry?: PluginManifestRegistry } {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const readiness = resolvePluginAutoEnableReadiness(
    config,
    env,
    params.discovery,
    params.ambientEnvTriggers,
  );
  if (!readiness.mayNeedAutoEnable) {
    return { candidates: [], manifestRegistry: params.manifestRegistry };
  }
  const registry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return {
    candidates: resolveConfiguredPluginAutoEnableCandidates({
      config,
      env,
      registry,
      configuredChannelIds: readiness.configuredChannelIds,
    }),
    manifestRegistry: registry,
  };
}
