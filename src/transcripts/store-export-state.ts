import { isStringRecord } from "@openclaw/normalization-core/record-coerce";

export function parseTranscriptExportManifest(json: string): Record<string, string> {
  const value: unknown = JSON.parse(json);
  if (!isStringRecord(value)) {
    throw new TypeError("Invalid transcript export manifest: expected an object of strings.");
  }
  return value;
}

export function parseTranscriptPendingExports(json: string): Set<string> {
  const value: unknown = JSON.parse(json);
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new TypeError("Invalid pending transcript exports: expected an array of strings.");
  }
  return new Set(value);
}
