import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";

/**
 * Plugin sources that live outside the bundled gateway package and therefore
 * can drift in version when the gateway is updated without a corresponding
 * `openclaw plugins update`.
 *
 * Bundled plugins ship inside the gateway npm package and always match the
 * gateway version, so they are never reported as drifted.
 */
const EXTERNALIZED_INSTALL_SOURCES: ReadonlySet<PluginInstallRecord["source"]> = new Set([
  "npm",
  "clawhub",
]);

export type PluginVersionDriftEntry = {
  pluginId: string;
  installedVersion: string;
  gatewayVersion: string;
  source: PluginInstallRecord["source"];
  packageName?: string;
  spec?: string;
};

export type PluginVersionDriftReport = {
  gatewayVersion: string;
  drifts: PluginVersionDriftEntry[];
};

/**
 * Strip a trailing build qualifier (e.g. `2026.5.4-1` -> `2026.5.4`) so that
 * a gateway packaged as `2026.5.4-1` is not reported as drifted from a
 * plugin packaged as `2026.5.4`. Both ends are normalized identically.
 */
function normalizeVersion(value: string): string {
  return value.replace(/-\d+$/, "");
}

function isExternalizedSource(source: PluginInstallRecord["source"] | undefined): boolean {
  if (!source) {
    return false;
  }
  return EXTERNALIZED_INSTALL_SOURCES.has(source);
}

function isPluginEnabled(config: OpenClawConfig | undefined, pluginId: string): boolean {
  // Default policy: a plugin without an explicit `enabled` entry is treated as
  // enabled. Drift is only surfaced for plugins that are explicitly enabled
  // (or implicitly so by absence of an entry); explicitly disabled plugins
  // are skipped because their version is not load-bearing for runtime health.
  const entry = config?.plugins?.entries?.[pluginId];
  if (!entry) {
    return true;
  }
  return entry.enabled !== false;
}

/**
 * Compare the installed version of each externalized plugin against the
 * running gateway version and return any mismatches.
 *
 * @param params.gatewayVersion The gateway version string (typically the
 *   `version` field of the installed openclaw package.json).
 * @param params.installRecords The full set of recorded plugin installs (as
 *   produced by `loadInstalledPluginIndexInstallRecords`).
 * @param params.config The merged daemon-side OpenClawConfig (optional). When
 *   provided, plugins explicitly disabled via `plugins.entries.<id>.enabled`
 *   are skipped.
 *
 * The returned `drifts` list is sorted by `pluginId` for stable output.
 */
export function detectPluginVersionDrift(params: {
  gatewayVersion: string;
  installRecords: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
}): PluginVersionDriftReport {
  const { gatewayVersion, installRecords, config } = params;
  const normalizedGateway = normalizeVersion(gatewayVersion);
  const drifts: PluginVersionDriftEntry[] = [];

  for (const [pluginId, record] of Object.entries(installRecords)) {
    if (!record) {
      continue;
    }
    if (!isExternalizedSource(record.source)) {
      continue;
    }
    if (!isPluginEnabled(config, pluginId)) {
      continue;
    }
    const installedVersion = record.resolvedVersion ?? record.version;
    if (!installedVersion) {
      // No version recorded for this install — nothing to compare against.
      // Don't fabricate drift; surface tooling (status.print) can flag this
      // separately if desired.
      continue;
    }
    if (normalizeVersion(installedVersion) === normalizedGateway) {
      continue;
    }
    drifts.push({
      pluginId,
      installedVersion,
      gatewayVersion,
      source: record.source,
      ...(record.resolvedName ? { packageName: record.resolvedName } : {}),
      ...(record.spec ? { spec: record.spec } : {}),
    });
  }

  drifts.sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  return {
    gatewayVersion,
    drifts,
  };
}
