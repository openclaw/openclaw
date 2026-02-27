/**
 * Format a Date as ISO 8601 with milliseconds and UTC offset in the system's local timezone.
 *
 * Output: `2026-02-27T09:43:19.593-05:00`
 */
export function formatLocalIsoWithOffset(now: Date): string {
  return formatIsoInTimezone(now);
}

/**
 * Format a Date as ISO 8601 with milliseconds and UTC offset in a specific IANA timezone.
 * Falls back to system local time if the timezone is invalid or Intl is unavailable.
 *
 * Output: `2026-02-27T09:43:19.593-05:00`
 */
export function formatIsoInTimezone(now: Date, timezone?: string): string {
  if (timezone) {
    try {
      return formatWithIntl(now, timezone);
    } catch {
      // Invalid timezone — fall through to system local
    }
  }
  return formatWithLocal(now);
}

/** Format using Intl.DateTimeFormat for a specific IANA timezone. */
function formatWithIntl(now: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(now)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  );
  const ms = String(now.getMilliseconds()).padStart(3, "0");

  // Compute UTC offset for the given timezone at this instant
  const utcMs = now.getTime();
  const localStr = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  // Parse as UTC to get the "wall clock" milliseconds, then diff against actual UTC
  const wallMs = new Date(localStr + "Z").getTime();
  const offsetMinutes = Math.round((wallMs - utcMs) / 60_000);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetH = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetM = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");

  return `${localStr}.${ms}${offsetSign}${offsetH}:${offsetM}`;
}

/** Format using system-local Date methods (original behavior). */
function formatWithLocal(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const tzOffset = now.getTimezoneOffset();
  const tzSign = tzOffset <= 0 ? "+" : "-";
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
  const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, "0");
  return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${tzSign}${tzHours}:${tzMinutes}`;
}
