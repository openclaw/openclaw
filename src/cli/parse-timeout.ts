import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { ExpectedCliError } from "./failure-output.js";

export function parseTimeoutMs(raw: unknown): number | undefined {
  return parseStrictPositiveInteger(typeof raw === "bigint" ? Number(raw) : raw);
}

function invalidTimeout(flagName: string, value?: string): ExpectedCliError {
  const suffix = value ? ` Received: "${value}".` : "";
  const message = `Invalid ${flagName}. Use a positive millisecond value, e.g. ${flagName} 30000.${suffix}`;
  return new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}

export function parseTimeoutMsWithFallback(
  raw: unknown,
  fallbackMs: number,
  options: {
    invalidType?: "fallback" | "error";
    // Each caller registers its own flag token; the rejection has to match it.
    flagName?: string;
  } = {},
): number {
  const flagName = options.flagName ?? "--timeout";
  if (raw === undefined || raw === null) {
    return fallbackMs;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : null;

  if (!value) {
    if (options.invalidType === "error") {
      throw invalidTimeout(flagName);
    }
    return fallbackMs;
  }

  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidTimeout(flagName, value);
  }
  return parsed;
}
