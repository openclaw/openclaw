// Doctor warnings for configured channels blocked by disabled channel plugins.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  listExplicitConfiguredChannelIdsForConfig,
  resolveConfiguredChannelPresencePolicy,
} from "../../../plugins/channel-plugin-ids.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../../plugins/config-state.js";
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

  const pluginsConfig = normalizePluginsConfig(activationSourceConfig.plugins);
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: cfg,
    env,
    includeDisabled: true,
  });
  const presencePolicy = resolveConfiguredChannelPresencePolicy({
    config: cfg,
    activationSourceConfig,
    env,
    includePersistedAuthState: false,
    manifestRecords: registry.plugins,
  });
  const activeConfiguredChannelIds = new Set(
    presencePolicy.filter((entry) => entry.effective).map((entry) => entry.channelId),
  );
  const blockedReasonsByChannelId = new Map(
    presencePolicy
      .filter((entry) => !entry.effective)
      .map((entry) => [entry.channelId, new Set(entry.blockedReasons)] as const),
  );
  const hits: ChannelPluginBlockerHit[] = [];

  for (const plugin of registry.plugins) {
    if (plugin.channels.length === 0) {
      continue;
    }

    const activationState = resolveEffectivePluginActivationState({
      id: plugin.id,
      origin: plugin.origin,
      config: pluginsConfig,
      rootConfig: activationSourceConfig,
      enabledByDefault: plugin.enabledByDefault,
    });
    if (
      activationState.activated ||
      !activationState.reason ||
      (activationState.reason !== "disabled in config" &&
        activationState.reason !== "plugins disabled")
    ) {
      continue;
    }

    for (const rawChannelId of plugin.channels) {
      const channelId = normalizeOptionalLowercaseString(rawChannelId);
      if (!channelId) {
        continue;
      }
      if (!configuredChannelIds.has(channelId)) {
        continue;
      }
      if (activeConfiguredChannelIds.has(channelId)) {
        continue;
      }
      hits.push({
        channelId,
        pluginId: plugin.id,
        reason: activationState.reason,
      });
    }
  }

  const channelsWithExplicitBlockerHits = new Set(hits.map((hit) => hit.channelId));

  for (const plugin of registry.plugins) {
    if (plugin.origin === "bundled" || plugin.channels.length === 0) {
      continue;
    }

    for (const rawChannelId of plugin.channels) {
      const channelId = normalizeOptionalLowercaseString(rawChannelId);
      if (!channelId) {
        continue;
      }
      if (!configuredChannelIds.has(channelId)) {
        continue;
      }
      if (channelsWithExplicitBlockerHits.has(channelId)) {
        continue;
      }
      if (activeConfiguredChannelIds.has(channelId)) {
        continue;
      }
      const blockedReasons = blockedReasonsByChannelId.get(channelId);
      const reason = blockedReasons?.has("untrusted-plugin")
        ? "missing explicit enablement"
        : blockedReasons?.has("not-in-allowlist")
          ? "not in allowlist"
          : undefined;
      if (!reason) {
        continue;
      }
      hits.push({
        channelId,
        pluginId: plugin.id,
        reason,
      });
    }
  }

  return hits;
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
