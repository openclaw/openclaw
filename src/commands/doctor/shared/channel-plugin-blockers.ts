// Doctor warnings for configured channels blocked by disabled channel plugins.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  hasExplicitChannelConfig,
  listExplicitConfiguredChannelIdsForConfig,
} from "../../../plugins/channel-plugin-ids.js";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  resolveManifestOwnerBasePolicyBlock,
  type ManifestOwnerBasePolicyBlockReason,
} from "../../../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../../plugins/plugin-registry.js";

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
    | "not in allowlist";
};

/** Find configured channel ids whose backing plugins cannot activate. */
export function scanConfiguredChannelPluginBlockers(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  activationSourceConfig: OpenClawConfig = cfg,
): ChannelPluginBlockerHit[] {
  const configuredChannelIds = new Set(
    listExplicitConfiguredChannelIdsForConfig(cfg)
      .map((channelId) => normalizeOptionalLowercaseString(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }

  const sourcePluginsConfig = normalizePluginsConfig(activationSourceConfig.plugins);
  const effectivePluginsConfig = normalizePluginsConfig(cfg.plugins);
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: cfg,
    env,
    includeDisabled: true,
  });
  const hits: ChannelPluginBlockerHit[] = [];

  for (const channelId of configuredChannelIds) {
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
      hits.push({
        channelId,
        pluginId: state.pluginId,
        reason: state.reason,
      });
    }
  }

  return hits;
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
      : (mapManifestOwnerBlockerReason(sourceBaseBlock) ??
        (!sourceExternalTrusted && sourceBaseBlock === null
          ? "missing explicit enablement"
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
  if (hit.reason === "not in allowlist") {
    return `external plugin "${sanitizeForLog(hit.pluginId)}" is installed but omitted from plugins.allow. Include "${sanitizeForLog(hit.pluginId)}" in plugins.allow.`;
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
