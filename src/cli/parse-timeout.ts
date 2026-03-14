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
