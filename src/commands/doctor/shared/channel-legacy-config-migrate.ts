// Legacy config migration bridge for channel doctor compatibility contracts.

import { isChannelConfigMetadataKey } from "../../../channels/config-metadata.js";
import { getBootstrapChannelPlugin } from "../../../channels/plugins/bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "../../../channels/plugins/doctor-contract-api.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { findUninspectedPluginDiagnostic } from "../../../plugins/discovery-availability.js";
import { discoverConfiguredPluginLoadPaths } from "../../../plugins/discovery.js";
import { applyPluginDoctorCompatibilitySequence } from "../../../plugins/doctor-compatibility-migration.js";
import type { PluginDoctorCompatibilityNormalizer } from "../../../plugins/doctor-contract-module.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  collectDoctorConfigRepairPluginIds,
  isPluginDoctorMigrationDeferred,
} from "../../../plugins/doctor-contract-registry.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";
import { isRecord } from "./legacy-config-record-shared.js";
import { HISTORICAL_WEBHOOK_CHANNELS } from "./legacy-webhook-pins.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

export function migrateHeartbeatVisibility(raw: Record<string, unknown>, changes: string[]): void {
  const channels = isRecord(raw.channels) ? raw.channels : null;
  if (!channels) {
    return;
  }
  const migrateEntry = (
    entry: Record<string, unknown>,
    path: string,
    preserveEmptyPluginBlock = false,
  ) => {
    const heartbeat = isRecord(entry.heartbeat) ? entry.heartbeat : null;
    const keys = heartbeat ? Object.keys(heartbeat) : [];
    if (
      !heartbeat ||
      (preserveEmptyPluginBlock && keys.length === 0) ||
      keys.some((key) => key !== "showOk" && key !== "showAlerts" && key !== "useIndicator")
    ) {
      return;
    }
    if (entry.heartbeatVisibility === undefined) {
      entry.heartbeatVisibility = entry.heartbeat;
      changes.push(`Moved ${path}.heartbeat → ${path}.heartbeatVisibility.`);
    } else {
      changes.push(`Removed ${path}.heartbeat (${path}.heartbeatVisibility already set).`);
    }
    delete entry.heartbeat;
  };
  const defaults = isRecord(channels.defaults) ? channels.defaults : null;
  if (defaults) {
    migrateEntry(defaults, "channels.defaults");
  }
  for (const [channelId, value] of Object.entries(channels)) {
    if (!channelId.trim() || isChannelConfigMetadataKey(channelId) || !isRecord(value)) {
      continue;
    }
    const preserveEmptyPluginBlock = channelId === "feishu";
    migrateEntry(value, `channels.${channelId}`, preserveEmptyPluginBlock);
    const accounts = isRecord(value.accounts) ? value.accounts : null;
    if (!accounts) {
      continue;
    }
    for (const [accountId, account] of Object.entries(accounts)) {
      if (isRecord(account)) {
        migrateEntry(
          account,
          `channels.${channelId}.accounts.${accountId}`,
          preserveEmptyPluginBlock,
        );
      }
    }
  }
}

function resolveBundledChannelCompatibilityNormalizer(
  channelId: string,
): PluginDoctorCompatibilityNormalizer | undefined {
  if (isPluginDoctorMigrationDeferred(channelId)) {
    return undefined;
  }
  const contractNormalizer =
    loadBundledChannelDoctorContractApi(channelId)?.normalizeCompatibilityConfig;
  if (typeof contractNormalizer === "function") {
    return contractNormalizer;
  }
  return getBootstrapChannelPlugin(channelId)?.doctor?.normalizeCompatibilityConfig;
}

/** Apply bundled and plugin channel compatibility migrations to a legacy config object. */
export function applyChannelDoctorCompatibilityMigrations(
  cfg: Record<string, unknown>,
  options?: { pluginContracts?: boolean; historicalWebhookListeners?: boolean },
): {
  next: Record<string, unknown>;
  changes: string[];
  warnings?: string[];
} {
  // SAFETY: Compatibility hooks accept legacy config before canonical validation.
  const config = cfg as OpenClawConfig;
  const loadPaths = config.plugins?.load?.paths ?? [];
  if (loadPaths.length > 0) {
    const warning = findUninspectedPluginDiagnostic(
      discoverConfiguredPluginLoadPaths({ loadPaths }).diagnostics,
    );
    if (warning) {
      log.warn(warning.message);
      return { next: cfg, changes: [] };
    }
  }
  const changes: string[] = [];
  migrateHeartbeatVisibility(cfg, changes);
  const unresolvedChannelIds: string[] = [];
  const bundled = applyPluginDoctorCompatibilitySequence(
    config,
    listDoctorConfiguredChannelIds(cfg, { configEntryPolicy: "raw", sort: "codepoint" }).map(
      (channelId) => {
        const normalizeCompatibilityConfig =
          resolveBundledChannelCompatibilityNormalizer(channelId);
        if (!normalizeCompatibilityConfig) {
          unresolvedChannelIds.push(channelId);
        }
        return { pluginId: channelId, normalizeCompatibilityConfig };
      },
    ),
  );
  // State-free previews cannot read the installed-plugin registry from shared state.
  const pluginIds =
    options?.pluginContracts === false
      ? []
      : [
          ...new Set([...unresolvedChannelIds, ...collectDoctorConfigRepairPluginIds(cfg)]),
        ].toSorted();
  const plugins: ReturnType<typeof applyPluginDoctorCompatibilityMigrations> =
    pluginIds.length || options?.historicalWebhookListeners
      ? applyPluginDoctorCompatibilityMigrations(bundled.config, {
          config,
          pluginIds: options?.historicalWebhookListeners
            ? [...new Set([...pluginIds, ...HISTORICAL_WEBHOOK_CHANNELS])]
            : pluginIds,
          historicalWebhookListeners: options?.historicalWebhookListeners,
        })
      : { config: bundled.config, changes: [] };
  // Bundled and installed contract views can report the same warning-only condition.
  const warnings = [...new Set([...(bundled.warnings ?? []), ...(plugins.warnings ?? [])])];
  return {
    next: plugins.config,
    changes: [...changes, ...bundled.changes, ...plugins.changes],
    ...(warnings.length ? { warnings } : {}),
  };
}
