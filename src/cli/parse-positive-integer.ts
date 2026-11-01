import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";

export function parseOptionalPositiveInteger(
  raw: unknown,
  label: string,
  suffix = "",
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = parseStrictPositiveInteger(raw);
  if (value === undefined) {
    throw new Error(`${label} must be a positive integer${suffix}`);
  }
  return value;
}
