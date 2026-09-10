// Plugin/channel activation config merge helpers.
// Carries activation enablement into runtime config without copying stale state.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";

// Activation config carries only operator-controlled enable/allow surfaces into
// runtime config. Other runtime fields stay canonical to avoid stale activation
// state overriding live config reloads.

function mergeEnabledEntries(
  runtimeValue: unknown,
  activationValue: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(activationValue)) {
    return undefined;
  }
  const runtimeEntries = isRecord(runtimeValue) ? runtimeValue : {};
  let nextEntries: Record<string, unknown> | undefined;
  for (const [id, activationEntry] of Object.entries(activationValue)) {
    if (!isRecord(activationEntry) || !Object.hasOwn(activationEntry, "enabled")) {
      continue;
    }
    const runtimeEntry = runtimeEntries[id];
    nextEntries ??= { ...runtimeEntries };
    nextEntries[id] = {
      ...(isRecord(runtimeEntry) ? runtimeEntry : {}),
      enabled: activationEntry.enabled,
    };
  }
  return nextEntries;
}

/** Merges plugin/channel activation enablement into the runtime config shape. */
export function mergeActivationSectionsIntoRuntimeConfig(params: {
  runtimeConfig: OpenClawConfig;
  activationConfig: OpenClawConfig;
}): OpenClawConfig {
  const { runtimeConfig, activationConfig } = params;
  const nextChannels = mergeEnabledEntries(runtimeConfig.channels, activationConfig.channels);
  const activationPlugins = activationConfig.plugins;
  let nextPlugins: Record<string, unknown> | undefined;
  if (isRecord(activationPlugins)) {
    const runtimePlugins = isRecord(runtimeConfig.plugins) ? runtimeConfig.plugins : {};
    if (Array.isArray(activationPlugins.allow)) {
      nextPlugins = { ...runtimePlugins, allow: [...activationPlugins.allow] };
    }
    const nextEntries = mergeEnabledEntries(runtimePlugins.entries, activationPlugins.entries);
    if (nextEntries !== undefined) {
      nextPlugins = { ...runtimePlugins, ...nextPlugins, entries: nextEntries };
    }
  }
  if (nextChannels === undefined && nextPlugins === undefined) {
    return runtimeConfig;
  }
  return {
    ...runtimeConfig,
    ...(nextChannels === undefined ? {} : { channels: nextChannels as OpenClawConfig["channels"] }),
    ...(nextPlugins === undefined ? {} : { plugins: nextPlugins as OpenClawConfig["plugins"] }),
  };
}

// Resolves the effective plugin config the gateway startup *plan* is built from:
// auto-enable the operator activation source, then merge those activation sections into
// the runtime config (so runtime/defaulted fields survive). This is the exact assembly
// `prepareGatewayPluginBootstrap` uses (non-minimal branch); sharing it keeps any consumer
// that recomputes the startup plan — notably the `/status plugins` should-run drift check —
// from drifting away from real gateway boot. Behavior-preserving extraction only.
export function resolveGatewayStartupPluginActivationConfig(params: {
  runtimeConfig: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): OpenClawConfig {
  return mergeActivationSectionsIntoRuntimeConfig({
    runtimeConfig: params.runtimeConfig,
    activationConfig: applyPluginAutoEnable({
      config: params.activationSourceConfig,
      env: params.env,
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
      discovery: params.discovery,
      ambientEnvTriggers: params.ambientEnvTriggers,
    }).config,
  });
}

/** Re-derives source-owned plugin activation and carries it into one reload candidate. */
export function resolveGatewayReloadPluginActivationCandidate(params: {
  runtimeConfig: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): { runtimeConfig: OpenClawConfig; compareConfig: OpenClawConfig } {
  const activationConfig = applyPluginAutoEnable({
    config: params.sourceConfig,
    env: params.env,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    discovery: params.discovery,
    ambientEnvTriggers: params.ambientEnvTriggers,
  }).config;
  return {
    runtimeConfig: mergeActivationSectionsIntoRuntimeConfig({
      runtimeConfig: params.runtimeConfig,
      activationConfig,
    }),
    compareConfig: activationConfig,
  };
}
