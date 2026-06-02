import fs from "node:fs";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

type ManifestBackedRecord = Pick<
  PluginManifestRecord | InstalledPluginIndexRecord,
  "bundleFormat" | "format" | "manifestPath"
>;

/** Returns whether a missing manifest file is allowed for Claude-format bundled records. */
export function hasOptionalMissingPluginManifestFile(record: ManifestBackedRecord): boolean {
  return (
    record.format === "bundle" &&
    record.bundleFormat === "claude" &&
    !fs.existsSync(record.manifestPath)
  );
}
