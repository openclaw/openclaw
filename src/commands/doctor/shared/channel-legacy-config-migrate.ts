// Legacy config migration bridge for channel doctor compatibility contracts.

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
import { migrateHeartbeatVisibility } from "../../doctor-heartbeat-visibility.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";
import { HISTORICAL_WEBHOOK_CHANNELS } from "./legacy-webhook-pins.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

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
