import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";
function stringBytes(values: readonly (string | undefined)[]): number {
  return values.reduce((bytes, value) => bytes + Buffer.byteLength(value ?? "", "utf8"), 0);
}

// Account for the captured payload, not a second per-command schema. Object keys
// and escaped strings deliberately overcharge the queue rather than omit new fields.
function commandBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return 8;
  }
  if (typeof value === "boolean") {
    return 1;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((bytes, entry) => bytes + 8 + commandBytes(entry), 0);
  }
  return Object.entries(value).reduce(
    (bytes, [key, entry]) => bytes + Buffer.byteLength(key, "utf8") + 8 + commandBytes(entry),
    0,
  );
}

export function requestBytes(request: OpenClawStateReadRequest): number {
  return (
    commandBytes(request.command) +
    commandBytes(request.context.databaseEngineSelection) +
    stringBytes([
      ...Object.entries(request.context.environment).flatMap(([key, value]) => [key, value]),
      request.context.existingSchemaPath,
      request.databasePath,
      request.location,
      request.expectedIdentity,
      request.snapshotRoot,
    ])
  );
}
