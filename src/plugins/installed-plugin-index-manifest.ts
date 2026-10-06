// Reads installed plugin manifests through index-owned paths.
import type { InstalledPluginIndexRecord } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { pluginCacheExistsSync } from "./plugin-cache-files.js";

type ManifestBackedRecord = Pick<
  PluginManifestRecord | InstalledPluginIndexRecord,
  "bundleFormat" | "format" | "manifestPath"
>;

/** True when the bundle format permits omitting its manifest file. */
export function isOptionalPluginManifestFile(record: ManifestBackedRecord): boolean {
  return record.format === "bundle" && record.bundleFormat === "claude";
}

/** True when a Claude bundle record omits its optional manifest file. */
export function hasOptionalMissingPluginManifestFile(record: ManifestBackedRecord): boolean {
  return isOptionalPluginManifestFile(record) && !pluginCacheExistsSync(record.manifestPath);
}
