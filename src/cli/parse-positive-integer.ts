import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { throwExpectedCliError } from "./expected-cli-error.js";

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
    throwExpectedCliError(`${label} must be a positive integer${suffix}`);
  }
  return value;
}
