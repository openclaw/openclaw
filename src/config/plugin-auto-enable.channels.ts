// Detects configured channel candidates without provider or setup runtime imports.
import {
  listPotentialConfiguredChannelPresenceSignals,
  type AmbientEnvTriggerPolicy,
} from "../channels/config-presence.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "../channels/plugins/package-state-probes.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.types.js";
import { hasExplicitManifestOwnerTrust } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.types.js";
import { isChannelConfigured } from "./channel-configured.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function normalizeManifestChannelId(channelId: string): string {
  return normalizeChatChannelId(channelId) ?? channelId;
}

function collectPluginIdsForConfiguredChannel(
  channelId: string,
  config: OpenClawConfig,
  registry: PluginManifestRegistry,
): string[] {
  const normalizedChannelId = normalizeManifestChannelId(channelId);
  const builtInId = normalizeChatChannelId(normalizedChannelId);
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  const claims = registry.plugins.filter(
    (record) =>
      (record.origin !== "workspace" ||
        hasExplicitManifestOwnerTrust({ plugin: record, normalizedConfig })) &&
      record.channels.some((id) => normalizeManifestChannelId(id) === normalizedChannelId),
  );

  if (claims.length === 0) {
    return builtInId ? [builtInId] : [];
  }

  const claimIds = new Set(claims.map((claim) => claim.id));
  if (builtInId) {
    claimIds.add(builtInId);
  }
  const preferredIds = new Set<string>();
  for (const claim of claims) {
    for (const preferredOverId of claim.channelConfigs?.[normalizedChannelId]?.preferOver ?? []) {
      if (claimIds.has(preferredOverId)) {
        // Keep both sides as candidates. The preferOver filter later disables
        // the lower-priority plugin unless the preferred plugin is explicitly
        // disabled/denied, preserving fallback to bundled channel support.
        preferredIds.add(claim.id);
        preferredIds.add(preferredOverId);
      }
    }
  }

  if (preferredIds.size > 0) {
    return [...preferredIds].toSorted((left, right) => left.localeCompare(right));
  }
  return [claims[0]?.id ?? builtInId ?? normalizedChannelId];
}

export function collectAutoEnableChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery?: PluginDiscoveryResult,
  ambientEnvTriggers?: AmbientEnvTriggerPolicy,
): string[] {
  const configuredStateChannelIds = new Set(
    listBundledChannelIdsForPackageState("configuredState", discovery),
  );
  return listPotentialConfiguredChannelPresenceSignals(cfg, env, {
    includePersistedAuthState: false,
    discovery,
    ambientEnvTriggers,
  }).flatMap((signal) => {
    const channelId = normalizeManifestChannelId(signal.channelId);
    if (
      signal.source === "env" &&
      configuredStateChannelIds.has(channelId) &&
      !hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId,
        cfg,
        env,
        discovery,
      })
    ) {
      return [];
    }
    return isChannelConfigured(cfg, channelId, env) ? [channelId] : [];
  });
}

export type ConfiguredPluginAutoEnableParams = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  configuredChannelIds?: readonly string[];
};

export function resolveConfiguredChannelAutoEnableCandidates(
  params: ConfiguredPluginAutoEnableParams,
): PluginAutoEnableCandidate[] {
  const changes: PluginAutoEnableCandidate[] = [];
  for (const channelId of params.configuredChannelIds ??
    collectAutoEnableChannelIds(params.config, params.env)) {
    for (const pluginId of collectPluginIdsForConfiguredChannel(
      channelId,
      params.config,
      params.registry,
    )) {
      changes.push({ pluginId, kind: "channel-configured", channelId });
    }
  }
  return changes;
}
