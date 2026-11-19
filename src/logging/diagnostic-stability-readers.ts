import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid stability bundle: ${label} must be a string`);
  }
  return value;
}

export function readCodeString(value: unknown, label: string): string {
  const code = readRequiredString(value, label);
  if (!SAFE_REASON_CODE.test(code)) {
    throw new Error(`Invalid stability bundle: ${label} must be a safe diagnostic code`);
  }
  return code;
}

export function readOptionalCodeString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const code = readRequiredString(value, label);
  return SAFE_REASON_CODE.test(code) ? code : undefined;
}

export function readTimestampString(value: unknown, label: string): string {
  const timestamp = readRequiredString(value, label);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`Invalid stability bundle: ${label} must be a valid timestamp`);
  }
  return timestamp;
}

export function readTimestampMs(value: unknown, label: string): number {
  const timestamp = readRequiredNumber(value, label);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`Invalid stability bundle: ${label} must be a valid timestamp`);
  }
  return timestamp;
}

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

export function readOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredNumber(value, label);
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
