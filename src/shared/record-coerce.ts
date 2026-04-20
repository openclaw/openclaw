// Keep this local so browser bundles do not pull in src/utils.ts and its Node-only side effects.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function readStringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumberField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBooleanField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readRecordField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function asNullableObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function hasOwnProperty(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return record !== null && record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
}

export function mergeRecords(
  ...records: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const record of records) {
    if (isRecord(record)) {
      Object.assign(result, record);
    }
  }
  return result;
}

export function pickFields(
  record: Record<string, unknown> | null | undefined,
  keys: string[],
): Record<string, unknown> {
  if (!isRecord(record)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      result[key] = record[key];
    }
  }
  return result;
}

export function omitFields(
  record: Record<string, unknown> | null | undefined,
  keys: string[],
): Record<string, unknown> {
  if (!isRecord(record)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  const omitSet = new Set(keys);
  for (const [key, value] of Object.entries(record)) {
    if (!omitSet.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
