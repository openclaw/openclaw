import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { throwExpectedCliError } from "./expected-cli-error.js";

export function parseTimeoutMs(raw: unknown): number | undefined {
  return parseStrictPositiveInteger(typeof raw === "bigint" ? Number(raw) : raw);
}

function invalidTimeout(flagName: string, value?: string): never {
  const suffix = value ? ` Received: "${value}".` : "";
  throwExpectedCliError(
    `Invalid ${flagName}. Use a positive millisecond value, e.g. ${flagName} 30000.${suffix}`,
  );
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
      invalidTimeout(flagName);
    }
    return fallbackMs;
  }

  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    invalidTimeout(flagName, value);
  }
  return parsed;
}
