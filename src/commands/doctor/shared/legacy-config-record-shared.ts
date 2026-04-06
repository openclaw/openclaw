type JsonRecord = Record<string, unknown>;

export type { JsonRecord };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

export function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  target[key] = next;
  return next;
}

export function hasOwnKey(target: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}
