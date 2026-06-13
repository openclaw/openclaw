// Doctor warnings for configured channels blocked by disabled channel plugins.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { listExplicitlyDisabledChannelIdsForConfig } from "../../../channels/config-presence.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  hasExplicitChannelConfig,
  listExplicitConfiguredChannelIdsForConfig,
  resolveConfiguredChannelPresencePolicy,
} from "../../../plugins/channel-plugin-ids.js";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../../../plugins/default-enablement.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  resolveManifestOwnerBasePolicyBlock,
  type ManifestOwnerBasePolicyBlockReason,
} from "../../../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../../plugins/plugin-registry.js";
import { isSafeChannelEnvVarTriggerName } from "../../../secrets/channel-env-var-names.js";

export type ChannelPluginBlockerHit = {
  /** Normalized configured channel id whose backing plugin is unavailable. */
  channelId: string;
  /** Plugin id that would provide the configured channel. */
  pluginId: string;
  /** Effective activation reason preventing the plugin from loading. */
  reason:
    | "disabled in config"
    | "plugins disabled"
    | "missing explicit enablement"
    | "not enabled"
    | "not enabled and not in allowlist"
    | "not in allowlist";
};

/** Find configured channel ids whose backing plugins cannot activate. */
export function scanConfiguredChannelPluginBlockers(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  activationSourceConfig: OpenClawConfig = cfg,
): ChannelPluginBlockerHit[] {
  const explicitChannelIds = listExplicitConfiguredChannelIdsForConfig(cfg)
    .map((channelId) => normalizeOptionalLowercaseString(channelId))
    .filter((channelId): channelId is string => Boolean(channelId));
  const sourcePluginsConfig = normalizePluginsConfig(activationSourceConfig.plugins);
  const effectivePluginsConfig = normalizePluginsConfig(cfg.plugins);
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: cfg,
    env,
    includeDisabled: true,
  });
  const manifestEnvOwners = listManifestEnvConfiguredChannelOwners(registry.plugins, env);
  const policyEntries = resolveConfiguredChannelPresencePolicy({
    config: cfg,
    activationSourceConfig,
    env,
    includePersistedAuthState: false,
    manifestRecords: registry.plugins,
  });
  // A manifest env match identifies one owner. Do not widen the same ambient env signal to
  // sibling owners that cannot consume that credential.
  const policyChannelIds = policyEntries
    .filter(
      (entry) =>
        !manifestEnvOwners.has(entry.channelId) ||
        entry.sources.some((source) => source !== "env" && source !== "manifest-env"),
    )
    .map((entry) => entry.channelId);
  const genericChannelIds = new Set([
    ...explicitChannelIds,
    ...(explicitChannelIds.length === 0 ? policyChannelIds : []),
  ]);
  for (const channelId of listExplicitlyDisabledChannelIdsForConfig(cfg)) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? channelId;
    genericChannelIds.delete(normalizedChannelId);
    manifestEnvOwners.delete(normalizedChannelId);
  }
  if (genericChannelIds.size === 0 && manifestEnvOwners.size === 0) {
    return [];
  }
  const hits: ChannelPluginBlockerHit[] = [];
  const hitKeys = new Set<string>();
  const addHits = (channelId: string, ownerStates: ChannelOwnerState[]) => {
    let reportedGlobalDisable = false;
    for (const state of ownerStates) {
      if (!state.reason) {
        continue;
      }
      if (state.reason === "plugins disabled") {
        if (reportedGlobalDisable) {
          continue;
        }
        reportedGlobalDisable = true;
      }
      const key = `${channelId}\0${state.pluginId}\0${state.reason}`;
      if (hitKeys.has(key)) {
        continue;
      }
      hitKeys.add(key);
      hits.push({
        channelId,
        pluginId: state.pluginId,
        reason: state.reason,
      });
    }
  };

  for (const channelId of genericChannelIds) {
    const owners = registry.plugins.filter((plugin) =>
      plugin.channels.some(
        (rawChannelId) => normalizeOptionalLowercaseString(rawChannelId) === channelId,
      ),
    );
    const ownerStates = owners.map((plugin) =>
      resolveConfiguredChannelOwnerState({
        plugin,
        channelId,
        sourceConfig: activationSourceConfig,
        sourcePluginsConfig,
        effectiveConfig: cfg,
        effectivePluginsConfig,
      }),
    );
    if (ownerStates.some((state) => state.available)) {
      continue;
    }
    addHits(channelId, ownerStates);
  }

  for (const [channelId, pluginIds] of manifestEnvOwners) {
    const owners = registry.plugins.filter((plugin) => pluginIds.has(plugin.id));
    const ownerStates = owners.map((plugin) =>
      resolveConfiguredChannelOwnerState({
        plugin,
        channelId,
        sourceConfig: activationSourceConfig,
        sourcePluginsConfig,
        effectiveConfig: cfg,
        effectivePluginsConfig,
      }),
    );
    addHits(
      channelId,
      ownerStates.filter((state) => !state.available),
    );
  }

  return hits;
}

function listManifestEnvConfiguredChannelOwners(
  plugins: readonly PluginManifestRecord[],
  env: NodeJS.ProcessEnv,
): Map<string, Set<string>> {
  const ownersByChannelId = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    const ownedChannelIds = new Set(
      plugin.channels
        .map((channelId) => normalizeOptionalLowercaseString(channelId))
        .filter((channelId): channelId is string => Boolean(channelId)),
    );
    for (const [rawChannelId, envVars] of Object.entries(plugin.channelEnvVars ?? {})) {
      const channelId = normalizeOptionalLowercaseString(rawChannelId);
      if (!channelId || !ownedChannelIds.has(channelId)) {
        continue;
      }
      const configured = envVars.some((envVar) => {
        if (!isSafeChannelEnvVarTriggerName(envVar)) {
          return false;
        }
        const value = env[envVar] ?? env[envVar.toUpperCase()];
        return typeof value === "string" && value.trim().length > 0;
      });
      if (!configured) {
        continue;
      }
      let ownerIds = ownersByChannelId.get(channelId);
      if (!ownerIds) {
        ownerIds = new Set();
        ownersByChannelId.set(channelId, ownerIds);
      }
      ownerIds.add(plugin.id);
    }
  }
  return ownersByChannelId;
}

type ChannelOwnerState = {
  pluginId: string;
  available: boolean;
  reason?: ChannelPluginBlockerHit["reason"];
};

function resolveConfiguredChannelOwnerState(params: {
  plugin: PluginManifestRecord;
  channelId: string;
  sourceConfig: OpenClawConfig;
  sourcePluginsConfig: ReturnType<typeof normalizePluginsConfig>;
  effectiveConfig: OpenClawConfig;
  effectivePluginsConfig: ReturnType<typeof normalizePluginsConfig>;
}): ChannelOwnerState {
  const bundledChannelConfigured =
    params.plugin.origin === "bundled" &&
    hasExplicitChannelConfig({
      config: params.sourceConfig,
      channelId: params.channelId,
    });
  const sourceAllowlistBypass =
    bundledChannelConfigured ||
    (params.plugin.origin === "workspace" &&
      params.sourcePluginsConfig.slots.contextEngine === params.plugin.id);
  const sourceBaseBlock = resolveManifestOwnerBasePolicyBlock({
    plugin: params.plugin,
    normalizedConfig: params.sourcePluginsConfig,
    allowRestrictiveAllowlistBypass: sourceAllowlistBypass,
  });
  const sourceExternalTrusted =
    params.plugin.origin === "bundled" ||
    (sourceBaseBlock === null &&
      (params.plugin.origin === "workspace"
        ? isActivatedManifestOwner({
            plugin: params.plugin,
            normalizedConfig: params.sourcePluginsConfig,
            rootConfig: params.sourceConfig,
          })
        : hasExplicitManifestOwnerTrust({
            plugin: params.plugin,
            normalizedConfig: params.sourcePluginsConfig,
          })));
  const sourceBundledActivated =
    params.plugin.origin === "bundled" &&
    (bundledChannelConfigured ||
      isActivatedManifestOwner({
        plugin: params.plugin,
        normalizedConfig: params.sourcePluginsConfig,
        rootConfig: params.sourceConfig,
      }));
  const sourceBundledNeedsExplicitEnablement =
    params.plugin.origin === "bundled" &&
    !isPluginEnabledByDefaultForPlatform(params.plugin) &&
    params.sourcePluginsConfig.entries[params.plugin.id]?.enabled !== true;

  const effectiveBundledChannelConfigured =
    params.plugin.origin === "bundled" &&
    hasExplicitChannelConfig({
      config: params.effectiveConfig,
      channelId: params.channelId,
    });
  const effectiveAllowlistBypass =
    effectiveBundledChannelConfigured ||
    (params.plugin.origin === "workspace" &&
      params.effectivePluginsConfig.slots.contextEngine === params.plugin.id);
  const effectiveBaseBlock = resolveManifestOwnerBasePolicyBlock({
    plugin: params.plugin,
    normalizedConfig: params.effectivePluginsConfig,
    allowRestrictiveAllowlistBypass: effectiveAllowlistBypass,
  });
  const available =
    effectiveBaseBlock === null &&
    sourceExternalTrusted &&
    (effectiveBundledChannelConfigured ||
      isActivatedManifestOwner({
        plugin: params.plugin,
        normalizedConfig: params.effectivePluginsConfig,
        rootConfig: params.effectiveConfig,
      }));
  return {
    pluginId: params.plugin.id,
    available,
    reason: available
      ? undefined
      : params.plugin.origin === "bundled" &&
          sourceBaseBlock === "not-in-allowlist" &&
          sourceBundledNeedsExplicitEnablement
        ? "not enabled and not in allowlist"
        : (mapManifestOwnerBlockerReason(sourceBaseBlock) ??
          (!sourceExternalTrusted && sourceBaseBlock === null
            ? "missing explicit enablement"
            : params.plugin.origin === "bundled" &&
                sourceBaseBlock === null &&
                !sourceBundledActivated
              ? "not enabled"
              : undefined)),
  };
}

function mapManifestOwnerBlockerReason(
  reason: ManifestOwnerBasePolicyBlockReason | null,
): ChannelPluginBlockerHit["reason"] | undefined {
  if (reason === "plugins-disabled") {
    return "plugins disabled";
  }
  if (reason === "plugin-disabled") {
    return "disabled in config";
  }
  if (reason === "not-in-allowlist") {
    return "not in allowlist";
  }
  return undefined;
}

function formatReason(hit: ChannelPluginBlockerHit): string {
  if (hit.reason === "disabled in config") {
    return `plugin "${sanitizeForLog(hit.pluginId)}" is disabled by plugins.entries.${sanitizeForLog(hit.pluginId)}.enabled=false.`;
  }
  if (hit.reason === "plugins disabled") {
    return `plugins.enabled=false blocks channel plugins globally.`;
  }
  if (hit.reason === "missing explicit enablement") {
    return `external plugin "${sanitizeForLog(hit.pluginId)}" is installed without explicit trust. Add plugins.entries.${sanitizeForLog(hit.pluginId)}.enabled=true.`;
  }
  if (hit.reason === "not enabled") {
    return `plugin "${sanitizeForLog(hit.pluginId)}" is installed but not enabled. Add plugins.entries.${sanitizeForLog(hit.pluginId)}.enabled=true.`;
  }
  if (hit.reason === "not enabled and not in allowlist") {
    return `plugin "${sanitizeForLog(hit.pluginId)}" is not enabled and is omitted from plugins.allow. Add plugins.entries.${sanitizeForLog(hit.pluginId)}.enabled=true and include "${sanitizeForLog(hit.pluginId)}" in plugins.allow.`;
  }
  if (hit.reason === "not in allowlist") {
    return `plugin "${sanitizeForLog(hit.pluginId)}" is installed but omitted from plugins.allow. Include "${sanitizeForLog(hit.pluginId)}" in plugins.allow.`;
  }
  return `plugin "${sanitizeForLog(hit.pluginId)}" is not loadable (${sanitizeForLog(hit.reason)}).`;
}

/** Format doctor warnings for configured channels blocked by plugin activation state. */
export function collectConfiguredChannelPluginBlockerWarnings(
  hits: ChannelPluginBlockerHit[],
): string[] {
  return hits.map(
    (hit) =>
      `- channels.${sanitizeForLog(hit.channelId)}: channel is configured, but ${formatReason(hit)} Fix plugin enablement before relying on setup guidance for this channel.`,
  );
}

/** Return true when a setup warning targets a channel already explained by plugin blockers. */
export function isWarningBlockedByChannelPlugin(
  warning: string,
  hits: ChannelPluginBlockerHit[],
): boolean {
  return hits.some((hit) => {
    const prefix = `channels.${sanitizeForLog(hit.channelId)}`;
    return warning.includes(`${prefix}:`) || warning.includes(`${prefix}.`);
  });
}
