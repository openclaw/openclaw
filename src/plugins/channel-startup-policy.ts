import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import {
  resolveEffectivePluginActivationState,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { resolveManifestOwnerBasePolicyBlock } from "./manifest-owner-policy.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

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
  const blocked = resolveManifestOwnerBasePolicyBlock({
    plugin: { id },
    normalizedConfig: pluginsConfig,
  });
  if (
    blocked &&
    (blocked !== "not-in-allowlist" ||
      origin !== "bundled" ||
      !(channelIds ?? []).some((channelId) =>
        hasExplicitChannelConfig({ config: activationSource.rootConfig ?? config, channelId }),
      ))
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
