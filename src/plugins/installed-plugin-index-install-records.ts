/** Normalizes durable plugin install records into installed-index metadata and back. */
import {
  copyPluginInstallRecordMap,
  parsePluginInstallRecordMap,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

/** Normalizes raw plugin install records into index-safe install record metadata. */
export function normalizeInstallRecordMap(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> {
  const normalized = parsePluginInstallRecordMap(records ?? {});
  if (!normalized) {
    throw new Error("Invalid plugin install record map");
  }
  return normalized;
}

/** Copy the caller-owned map; its admitted record values remain shared. */
export function extractPluginInstallRecordsFromInstalledPluginIndex(
  index: InstalledPluginIndex | null | undefined,
): Record<string, PluginInstallRecord> {
  return copyPluginInstallRecordMap(index?.installRecords);
}
