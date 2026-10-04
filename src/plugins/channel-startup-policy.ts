import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import {
  resolveEffectivePluginActivationState,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

/** Shares configured-channel eligibility between startup and manifest schema selection. */
export function canStartConfiguredChannelPlugin(params: {
  id: string;
  origin: PluginOrigin;
  /** Declared channel ids for disable checks and bundled allowlist exceptions. */
  channelIds?: readonly string[];
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
}): boolean {
  const { id, origin, channelIds, config, pluginsConfig, activationSource } = params;
  const policyId = normalizePluginPolicyId(id);
  if (
    !pluginsConfig.enabled ||
    pluginsConfig.deny.includes(policyId) ||
    pluginsConfig.entries[policyId]?.enabled === false
  ) {
    return false;
  }
  const explicitBundledChannelConfig =
    origin === "bundled" &&
    (channelIds ?? []).some((channelId) =>
      hasExplicitChannelConfig({
        config: activationSource.rootConfig ?? config,
        channelId,
      }),
    );
  if (
    pluginsConfig.allow.length > 0 &&
    !pluginsConfig.allow.includes(policyId) &&
    !explicitBundledChannelConfig
  ) {
    return false;
  }
  if (origin === "bundled") {
    return true;
  }
  // Materialized allowlists govern eligibility; only authored selection grants
  // explicit activation. Using either snapshot for both would change channel trust.
  const activationState = resolveEffectivePluginActivationState({
    id,
    origin,
    channelIds,
    config: pluginsConfig,
    rootConfig: config,
    activationSource,
  });
  return activationState.enabled && activationState.explicitlyEnabled;
}
