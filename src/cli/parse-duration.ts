import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { durationUnitMs } from "../infra/format-time/duration-units.js";

type DurationMsParseOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d";
};

const MAX_TOKEN_LENGTH = 100;
// The token limit bounds decimal precision. Use one exact scale across units and segments.
const DURATION_SCALE = 10n ** BigInt(MAX_TOKEN_LENGTH);

const DURATION_UNIT_MS = new Map<string, number>([
  ["ms", durationUnitMs.millisecond],
  ["s", durationUnitMs.second],
  ["m", durationUnitMs.minute],
  ["h", durationUnitMs.hour],
  ["d", durationUnitMs.day],
]);

function invalidDuration(raw: string, reason?: string): Error {
  const value = raw.trim() ? `"${raw}"` : "empty value";
  const prefix = reason ? `Invalid duration (${reason}): ${value}.` : `Invalid duration: ${value}.`;
  return new Error(`${prefix} Use values like 500ms, 30s, 5m, 2h, or 1h30m.`);
}

function parseScaledDurationToken(raw: string, value: string, unit: string): bigint {
  const multiplier = DURATION_UNIT_MS.get(unit);
  if (multiplier === undefined || value.length + unit.length > MAX_TOKEN_LENGTH) {
    throw invalidDuration(raw);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(MAX_TOKEN_LENGTH, "0")}`) * BigInt(multiplier);
}

function roundSafeDurationMs(raw: string, scaledMs: bigint): number {
  const ms = Number((scaledMs + DURATION_SCALE / 2n) / DURATION_SCALE);
  if (!Number.isSafeInteger(ms)) {
    throw invalidDuration(raw);
  }
  return ms;
}

export function parseDurationMs(raw: string, opts?: DurationMsParseOptions): number {
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (!trimmed) {
    throw invalidDuration(raw, "empty");
  }

  const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
  if (single) {
    const value = single[1] ?? "";
    const unit = single[2] ?? opts?.defaultUnit ?? "ms";
    return roundSafeDurationMs(raw, parseScaledDurationToken(raw, value, unit));
  }

  // Composite form (e.g. "1h30m", "2m500ms"); each token must include a unit.
  let scaledMs = 0n;
  let consumed = 0;
  const tokenRe = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  for (const match of trimmed.matchAll(tokenRe)) {
    const [full, valueRaw, unitRaw] = match;
    if (!full || !valueRaw || !unitRaw) {
      throw invalidDuration(raw);
    }
    if (match.index !== consumed) {
      throw invalidDuration(raw, "each composite segment needs a unit");
    }
    scaledMs += parseScaledDurationToken(raw, valueRaw, unitRaw);
    consumed += full.length;
  }

  if (consumed !== trimmed.length) {
    throw invalidDuration(raw);
  }

  return roundSafeDurationMs(raw, scaledMs);
}
