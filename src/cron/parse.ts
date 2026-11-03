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
    // Compact calendar datetimes (yyyyMMddHHmmss) are also pure digits. Any
    // digit string past 13 characters exceeds the epoch-ms range reachable
    // within the far-future scheduling cap, so treat it as a misread compact
    // date and reject it rather than schedule centuries off.
    if (raw.length > 13) {
      return null;
    }
    const n = parseStrictPositiveInteger(raw);
    if (n !== undefined && Number.isFinite(new Date(n).getTime())) {
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
