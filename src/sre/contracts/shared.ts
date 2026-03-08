import crypto from "node:crypto";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};

function normalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const sortedEntries = Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const normalized: JsonObject = {};
  for (const [key, entryValue] of sortedEntries) {
    normalized[key] = normalizeJsonValue(entryValue);
  }
  return normalized;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function deterministicArtifactId(prefix: string, value: JsonValue): string {
  const hash = crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
  return `${prefix}:${hash.slice(0, 16)}`;
}
