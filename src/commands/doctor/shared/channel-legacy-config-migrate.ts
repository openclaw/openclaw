// Legacy config migration bridge for channel doctor compatibility contracts.

import { isChannelConfigMetadataKey } from "../../../channels/config-metadata.js";
import { getBootstrapChannelPlugin } from "../../../channels/plugins/bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "../../../channels/plugins/doctor-contract-api.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { findUninspectedPluginDiagnostic } from "../../../plugins/discovery-availability.js";
import { discoverConfiguredPluginLoadPaths } from "../../../plugins/discovery.js";
import { applyPluginDoctorCompatibilityMigration } from "../../../plugins/doctor-compatibility-migration.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  collectDoctorConfigRepairPluginIds,
  isPluginDoctorMigrationDeferred,
} from "../../../plugins/doctor-contract-registry.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";
import { isRecord } from "./legacy-config-record-shared.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

type ChannelDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type ChannelDoctorCompatibilityNormalizer = (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorCompatibilityMutation;

function migrateHeartbeatVisibility(raw: Record<string, unknown>, changes: string[]): void {
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
): ChannelDoctorCompatibilityNormalizer | undefined {
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

function collectPluginDoctorCompatibilityIds(params: {
  raw: unknown;
  unresolvedChannelIds: readonly string[];
}): string[] {
  return [
    ...new Set([...params.unresolvedChannelIds, ...collectDoctorConfigRepairPluginIds(params.raw)]),
  ].toSorted();
}

/** Apply bundled and plugin channel compatibility migrations to a legacy config object. */
export function applyChannelDoctorCompatibilityMigrations(
  cfg: Record<string, unknown>,
  options?: { pluginContracts?: boolean },
): {
  next: Record<string, unknown>;
  changes: string[];
  warnings?: string[];
} {
  let nextCfg = cfg as OpenClawConfig;
  const loadPaths = nextCfg.plugins?.load?.paths ?? [];
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
  const warnings: string[] = [];
  migrateHeartbeatVisibility(cfg, changes);
  const unresolvedChannelIds: string[] = [];

  for (const channelId of listDoctorConfiguredChannelIds(cfg, {
    configEntryPolicy: "raw",
    sort: "codepoint",
  })) {
    const normalizeCompatibilityConfig = resolveBundledChannelCompatibilityNormalizer(channelId);
    if (!normalizeCompatibilityConfig) {
      unresolvedChannelIds.push(channelId);
      continue;
    }
    const mutation = applyPluginDoctorCompatibilityMigration({
      pluginId: channelId,
      config: nextCfg,
      normalize: normalizeCompatibilityConfig,
    });
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
    warnings.push(...(mutation.warnings ?? []));
  }

  // Plugin id collection loads the installed-plugin registry from the shared state
  // database; state-free preview callers opt out and rely on the full committer run.
  const pluginIds =
    options?.pluginContracts === false
      ? []
      : collectPluginDoctorCompatibilityIds({ raw: cfg, unresolvedChannelIds });
  if (pluginIds.length > 0) {
    const compat = applyPluginDoctorCompatibilityMigrations(nextCfg, {
      config: cfg as OpenClawConfig,
      pluginIds,
    });
    nextCfg = compat.config;
    changes.push(...compat.changes);
    warnings.push(...(compat.warnings ?? []));
  }

  return {
    next: nextCfg as OpenClawConfig & Record<string, unknown>,
    changes,
    ...(warnings.length ? { warnings } : {}),
  };
}
