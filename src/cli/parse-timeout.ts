import { InvalidArgumentError } from "commander";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";

export const CLI_TIMEOUT_MS_ERROR = "--timeout must be a positive integer (milliseconds)";

export function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "bigint") {
    value = Number(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    value = Number.parseInt(trimmed, 10);
  }
  return Number.isFinite(value) ? value : undefined;
}

export function parseTimeoutMsWithFallback(
  raw: unknown,
  fallbackMs: number,
  options: {
    invalidType?: "fallback" | "error";
  } = {},
): number {
  if (raw === undefined || raw === null) {
    return fallbackMs;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : null;

  if (value === null) {
    if (options.invalidType === "error") {
      throw new Error("invalid --timeout");
    }
    return fallbackMs;
  }

  if (!value) {
    return fallbackMs;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  return parsed;
}

export function parseStrictTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  return parseStrictPositiveInteger(raw);
}

export function parseTimeoutOption(raw: string): string {
  const parsed = parseStrictTimeoutMs(raw);
  if (parsed === undefined) {
    throw new InvalidArgumentError(CLI_TIMEOUT_MS_ERROR);
  }
  return raw.trim();
}

export function resolveTimeoutMs(raw: unknown, fallbackMs: number): number {
  if (raw === undefined || raw === null) {
    return fallbackMs;
  }
  const parsed = parseStrictTimeoutMs(raw);
  if (parsed === undefined) {
    throw new Error(CLI_TIMEOUT_MS_ERROR);
  }
  return parsed;
}
