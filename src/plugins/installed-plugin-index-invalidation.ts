// Invalidates installed plugin index entries after activation metadata changes.
import { hasConfigPathActivationMetadataMigration } from "./installed-plugin-index-config-path-scope.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRefreshReason,
} from "./installed-plugin-index-types.js";

export function diffInstalledPluginIndexInvalidationReasons(
  previous: InstalledPluginIndex,
  current: InstalledPluginIndex,
): readonly InstalledPluginIndexRefreshReason[] {
  const reasons = new Set<InstalledPluginIndexRefreshReason>();
  if (previous.version !== current.version) {
    reasons.add("missing");
  }
  if (previous.hostContractVersion !== current.hostContractVersion) {
    reasons.add("host-contract-changed");
  }
  if (previous.compatRegistryVersion !== current.compatRegistryVersion) {
    reasons.add("compat-registry-changed");
  }
  if (previous.migrationVersion !== current.migrationVersion) {
    reasons.add("migration");
  }
  if (previous.policyHash !== current.policyHash) {
    reasons.add("policy-changed");
  }
  if (hashJson(previous.installRecords ?? {}) !== hashJson(current.installRecords ?? {})) {
    reasons.add("source-changed");
  }

  const previousByPluginId = new Map(previous.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const currentByPluginId = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const [pluginId, previousPlugin] of previousByPluginId) {
    const currentPlugin = currentByPluginId.get(pluginId);
    if (!currentPlugin) {
      // A previously installed plugin is no longer in the discovery results.
      // This can happen when a bundled plugin is externalized (e.g. Slack)
      // or the plugin was uninstalled. Log a warning so users can diagnose
      // the issue rather than discovering the plugin silently disappeared.
      console.warn(
        `plugin ${pluginId}: previously installed plugin not found in discovery ` +
          `(previous path: ${previousPlugin.rootDir ?? "unknown"}). ` +
          `If this was unexpected, check that the plugin is still installed and ` +
          `configured in plugins.allow.`,
      );
      reasons.add("source-changed");
      continue;
    }
    if (
      previousPlugin.rootDir !== currentPlugin.rootDir ||
      previousPlugin.manifestPath !== currentPlugin.manifestPath ||
      previousPlugin.installRecordHash !== currentPlugin.installRecordHash
    ) {
      reasons.add("source-changed");
    }
    if (previousPlugin.enabled !== currentPlugin.enabled) {
      reasons.add("policy-changed");
    }
    if (
      hasConfigPathActivationMetadataMigration({
        previous: previousPlugin,
        current: currentPlugin,
      })
    ) {
      reasons.add("migration");
    }
    if (previousPlugin.manifestHash !== currentPlugin.manifestHash) {
      reasons.add("stale-manifest");
    }
    if (
      previousPlugin.packageVersion !== currentPlugin.packageVersion ||
      previousPlugin.packageJson?.path !== currentPlugin.packageJson?.path ||
      previousPlugin.packageJson?.hash !== currentPlugin.packageJson?.hash
    ) {
      reasons.add("stale-package");
    }
  }
  for (const pluginId of currentByPluginId.keys()) {
    if (!previousByPluginId.has(pluginId)) {
      const currentPlugin = currentByPluginId.get(pluginId);
      if (currentPlugin?.enabled === false) {
        continue;
      }
      reasons.add("source-changed");
    }
  }

  return Array.from(reasons).toSorted((left, right) => left.localeCompare(right));
}
