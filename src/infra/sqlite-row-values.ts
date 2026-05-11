import { asFiniteNumber } from "../shared/number-coercion.js";
import { normalizeNullableString } from "../shared/string-coerce.js";

export function sqliteNullableText(value: unknown): string | null {
  return normalizeNullableString(value);
}

export function sqliteNullableNumber(value: unknown): number | null {
  return asFiniteNumber(value) ?? null;
}

export function sqliteBooleanInteger(value: unknown): 0 | 1 | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

export function sqliteIntegerBoolean(value: unknown): boolean | undefined {
  return typeof value === "number" || typeof value === "bigint" ? value !== 0 : undefined;
}
