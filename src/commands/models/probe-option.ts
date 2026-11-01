import {
  parseStrictFiniteNumber,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { throwExpectedCliError } from "../../cli/failure-output.js";

export function parseProbeOption(
  raw: unknown,
  label: string,
  fallback: number,
  kind: "number" | "integer" = "number",
): number {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const parsed =
    kind === "integer" ? parseStrictPositiveInteger(raw) : parseStrictFiniteNumber(raw);
  if (parsed === undefined || parsed <= 0) {
    throwExpectedCliError(`${label} must be a positive ${kind}.`);
  }
  return parsed;
}
