export function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonValue<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

export function booleanToInteger(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

export function integerToBoolean(value: number | bigint | null): boolean | undefined {
  const normalized = normalizeNumber(value);
  return normalized == null ? undefined : normalized !== 0;
}

export function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

export function parseJsonArray(raw: string | null): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseJsonObject<unknown>(raw, undefined);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : undefined;
}
