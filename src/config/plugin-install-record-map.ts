import { Buffer } from "node:buffer";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginInstallRecord } from "./types.plugins.js";
import { StrictPluginInstallRecordSchema } from "./zod-schema.installs.js";

export const PluginInstallRecordSchema = StrictPluginInstallRecordSchema.passthrough();

const NORMALIZED_STRING_FIELDS = [
  "spec",
  "sourcePath",
  "installPath",
  "version",
  "resolvedName",
  "resolvedVersion",
  "resolvedSpec",
  "integrity",
  "shasum",
  "resolvedAt",
  "installedAt",
  "clawhubUrl",
  "clawhubPackage",
  "clawhubTrustScanStatus",
  "clawhubTrustModerationState",
  "clawhubTrustCheckedAt",
  "clawhubTrustAcknowledgedAt",
  "npmIntegrity",
  "npmShasum",
  "npmTarballName",
  "clawpackSha256",
  "clawpackManifestSha256",
  "gitUrl",
  "gitRef",
  "gitCommit",
  "marketplaceName",
  "marketplaceSource",
  "marketplacePlugin",
  "acceptedSurfaceHash",
  "acceptedSurfaceAt",
  "acceptedSurfaceIntegrity",
] as const satisfies readonly (keyof PluginInstallRecord)[];

export type PluginInstallRecordMapState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; records: Record<string, PluginInstallRecord> };

export function createPluginInstallRecordMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function setPluginInstallRecordMapEntry<T>(
  records: Record<string, T>,
  pluginId: string,
  record: T,
): void {
  Object.defineProperty(records, pluginId, {
    configurable: true,
    enumerable: true,
    value: record,
    writable: true,
  });
}

export function getPluginInstallRecordMapEntry<T>(
  records: Readonly<Record<string, T>> | undefined,
  pluginId: string,
): T | undefined {
  return records && Object.hasOwn(records, pluginId) ? records[pluginId] : undefined;
}

export function copyPluginInstallRecordMap<T>(
  records: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const copied = createPluginInstallRecordMap<T>();
  for (const [pluginId, record] of Object.entries(records ?? {})) {
    setPluginInstallRecordMapEntry(copied, pluginId, record);
  }
  return copied;
}

export function parsePluginInstallRecord(value: unknown): PluginInstallRecord | null {
  const parsed = PluginInstallRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const record = parsed.data;
  for (const field of NORMALIZED_STRING_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue === undefined) {
      continue;
    }
    const normalized = fieldValue.trim();
    if (normalized) {
      record[field] = normalized;
    } else {
      delete record[field];
    }
  }
  if (record.clawhubTrustReasons) {
    const reasons = record.clawhubTrustReasons.map((entry) => entry.trim()).filter(Boolean);
    if (reasons.length > 0) {
      record.clawhubTrustReasons = reasons;
    } else {
      delete record.clawhubTrustReasons;
    }
  }
  return record;
}

export function parsePluginInstallRecordMap(
  value: unknown,
): Record<string, PluginInstallRecord> | null {
  if (!isRecord(value)) {
    return null;
  }
  const records = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, rawRecord] of Object.entries(value)) {
    const record = parsePluginInstallRecord(rawRecord);
    if (!record) {
      return null;
    }
    setPluginInstallRecordMapEntry(records, pluginId, record);
  }
  return records;
}

export function inspectPluginInstallRecordMap(value: unknown): PluginInstallRecordMapState {
  if (value === undefined) {
    return { status: "missing" };
  }
  const records = parsePluginInstallRecordMap(value);
  return records ? { status: "valid", records } : { status: "invalid" };
}

/**
 * Object enumeration reorders integer-index keys, so persisted bytes must be
 * assembled from sorted entries instead of relying on object insertion order.
 */
export function serializePluginInstallRecordMap(
  records: Readonly<Record<string, PluginInstallRecord>>,
): string {
  return `{${Object.entries(records)
    .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([pluginId, record]) => `${JSON.stringify(pluginId)}:${JSON.stringify(record)}`)
    .join(",")}}`;
}
