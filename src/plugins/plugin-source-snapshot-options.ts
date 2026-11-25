import type { PluginInstallRecord } from "../config/types.plugins.js";

/** Only installer-owned copies can publish a frozen source generation. */
export function isManagedPluginSnapshotSource(record: PluginInstallRecord): boolean {
  return record.source !== "path" && Boolean(record.installPath?.trim());
}
