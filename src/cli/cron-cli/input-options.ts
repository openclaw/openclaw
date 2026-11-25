import {
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAbsoluteTimeMs } from "../../cron/parse.js";
import { resolveTimezone } from "../../infra/format-time/format-datetime.js";
import { parseOffsetlessIsoDateTimeInTimeZone } from "../../infra/format-time/parse-offsetless-zoned-datetime.js";
import { isOffsetlessIsoDateTime } from "../../shared/iso-time.js";
import { parseDurationMs as parseSharedDurationMs } from "../parse-duration.js";
import { CronCliError } from "./cron-cli-error.js";

function parseCronArgv(value: unknown, flag: string): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CronCliError(`${flag} must be a JSON array of strings`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new CronCliError(`${flag} must be a non-empty JSON array of non-empty strings`);
  }
  return parsed;
}

export function parseCronCommandArgv(value: unknown): string[] | undefined {
  return parseCronArgv(value, "--command-argv");
}

export function parseCronStreamCommandArgv(value: unknown): string[] | undefined {
  return parseCronArgv(value, "--stream-command");
}

export function parsePositiveCronDurationMs(input: string): number | null {
  try {
    const result = parseSharedDurationMs(input);
    return result > 0 && result <= MAX_DATE_TIMESTAMP_MS ? result : null;
  } catch {
    return null;
  }
}

export function parseCronStaggerMs(params: {
  staggerRaw: string;
  useExact: boolean;
}): number | undefined {
  if (params.useExact) {
    return 0;
  }
  if (!params.staggerRaw) {
    return undefined;
  }
  const parsed = parsePositiveCronDurationMs(params.staggerRaw);
  if (!parsed) {
    throw new CronCliError("Invalid --stagger; use e.g. 30s, 1m, 5m");
  }
  return parsed;
}

const INVALID_CRON_TIMEZONE_MESSAGE =
  "Invalid --tz. Use an IANA timezone such as America/New_York.";

export function parseCronTimezoneOption(value: unknown): string | undefined {
  const timezone = normalizeOptionalString(value);
  if (timezone && !resolveTimezone(timezone)) {
    throw new CronCliError(INVALID_CRON_TIMEZONE_MESSAGE);
  }
  return timezone;
}

// Offset-less datetimes use the supplied IANA timezone instead of UTC.
export function parseAt(input: string, tz?: string): string | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  // If a timezone is provided and the input looks like an offset-less ISO datetime,
  // resolve it in the given IANA timezone so users get the time they expect.
  if (tz && isOffsetlessIsoDateTime(raw)) {
    const parsed = parseOffsetlessIsoDateTimeInTimeZone(raw, tz);
    if (!parsed.ok) {
      if (parsed.reason === "invalid-timezone") {
        throw new CronCliError(INVALID_CRON_TIMEZONE_MESSAGE);
      }
      return null;
    }
    return parsed.iso;
  }
  parseCronTimezoneOption(tz);

  const absolute = parseAbsoluteTimeMs(raw);
  if (absolute !== null) {
    return timestampMsToIsoString(absolute) ?? null;
  }
  const durationInput = raw.startsWith("+") ? raw.slice(1) : raw;
  const dur = parsePositiveCronDurationMs(durationInput);
  if (dur !== null) {
    const expiresAt = resolveExpiresAtMsFromDurationMs(dur);
    return timestampMsToIsoString(expiresAt) ?? null;
  }
  return null;
}
