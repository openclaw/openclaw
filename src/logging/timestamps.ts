function formatSystemLocal(now: Date): string {
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

export function formatLocalIsoWithOffset(now: Date, timezone?: string): string {
  // If no timezone is specified, use the system's local time (legacy behavior)
  if (!timezone) {
    return formatSystemLocal(now);
  }

  // Use Intl.DateTimeFormat to format parts in the target timezone
  try {
    const options: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
      timeZoneName: "longOffset", // e.g., "GMT+08:00"
    };

    // Format parts to easily extract components
    const formatter = new Intl.DateTimeFormat("en-US", options);
    const parts = formatter.formatToParts(now);

    const getPart = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value;

    const year = getPart("year");
    const month = getPart("month");
    const day = getPart("day");
    const h = getPart("hour");
    const m = getPart("minute");
    const s = getPart("second");
    const ms = getPart("fractionalSecond");
    const tzName = getPart("timeZoneName"); // "GMT+08:00" or "GMT-05:00"

    // Parse the offset from "GMT+08:00" -> "+08:00"
    // Intl usually returns "GMT+HH:mm" or "GMT" (for UTC)
    let offset = "+00:00";
    if (tzName) {
      if (tzName === "GMT") {
        offset = "+00:00";
      } else if (tzName.startsWith("GMT")) {
        offset = tzName.replace("GMT", "");
      }
    }

    return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${offset}`;
  } catch {
    // Fallback to system local time if timezone is invalid.
    // NOTE: Do NOT use console.error here! formatting logic is used by console.log/error patches, call stack overflow will occur.
    return formatSystemLocal(now);
  }
}

export function formatConsoleTimestamp(
  style: "pretty" | "compact" | "json",
  timezone?: string,
): string {
  const now = new Date();
  const iso = formatLocalIsoWithOffset(now, timezone);
  if (style === "pretty") {
    // Extract HH:mm:ss from ISO string (YYYY-MM-DDTHH:mm:ss.sss...)
    return iso.slice(11, 19);
  }
  return iso;
}
