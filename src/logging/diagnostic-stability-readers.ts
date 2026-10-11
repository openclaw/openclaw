import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid stability bundle: ${label} must be an object`);
  }
  return value;
}

export function readRequiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid stability bundle: ${label} must be a finite number`);
  }
  return value;
}

export function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = readRequiredNumber(value, label);
  return parsed >= 0 ? Math.floor(parsed) : undefined;
}

export function assignOptionalFields<T extends object, K extends keyof T & string>(
  target: T,
  source: Record<string, unknown>,
  label: string,
  fields: readonly K[],
  read: (value: unknown, label: string) => T[K] | undefined,
): void {
  // The fixed order preserves serialized fields and the first failing validation label.
  for (const key of fields) {
    const parsed = read(source[key], `${label}.${key}`);
    if (parsed !== undefined) {
      target[key] = parsed;
    }
  }
}
