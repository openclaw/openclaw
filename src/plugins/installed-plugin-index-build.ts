import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { resolveInstalledPluginIndexRegistry } from "./installed-plugin-index-registry.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";

export function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): InstalledPluginIndex {
  const env = params.env ?? process.env;
  const installRecordInput = params.installRecords ?? {};
  const { candidates, registry } = resolveInstalledPluginIndexRegistry({
    ...params,
    installRecords: installRecordInput,
  });
  const registryDiagnostics = registry.diagnostics ?? [];
  const diagnostics = [...registryDiagnostics];
  const generatedAtMs = (params.now?.() ?? new Date()).getTime();
  const installRecords = normalizeInstallRecordMap(installRecordInput);
  const plugins = buildInstalledPluginIndexRecords({
    candidates,
    registry,
    config: params.config,
    diagnostics,
    installRecords,
  });

  return {
    version: INSTALLED_PLUGIN_INDEX_VERSION,
    warning: INSTALLED_PLUGIN_INDEX_WARNING,
    hostContractVersion: resolveCompatibilityHostVersion(env),
    compatRegistryVersion: resolveCompatRegistryVersion(),
    migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    generatedAtMs,
    ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
    installRecords,
    plugins,
    diagnostics,
  };
}
