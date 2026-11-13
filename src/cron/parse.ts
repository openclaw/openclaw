/** Parses cron schedule timestamps from user-facing absolute time strings. */
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { hasValidIsoCalendarComponents, normalizeUtcIso } from "../shared/iso-time.js";

/** Parses absolute cron timestamps from epoch milliseconds or ISO-like strings normalized to UTC. */
export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const n = parseStrictPositiveInteger(raw);
    // Compact calendar datetimes (yyyyMMddHHmmss) are also pure digits and
    // land far beyond any schedulable epoch-ms value, so reject them rather
    // than schedule centuries off. Compare the parsed value, not the digit
    // count, so zero-padded epochs for valid dates (01798761600000 =
    // 2027-01-01 UTC) keep parsing. Accepted edge: genuine epoch-ms values
    // cross this bound after year 2286 and are rejected too.
    if (n !== undefined && n < 10_000_000_000_000 && Number.isFinite(new Date(n).getTime())) {
      return n;
    }
    return null;
  }
  if (!hasValidIsoCalendarComponents(raw)) {
    return null;
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
