import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";

export function parseLogsPositiveInt(
  value: string | undefined,
  fallback: number,
  flag: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}
