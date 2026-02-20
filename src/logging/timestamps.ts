export function formatLocalIsoWithOffset(now: Date, timeZone?: string): string {
  const tz = timeZone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Use Intl.DateTimeFormat to get date/time parts in the target timezone
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    fractionalSecondDigits: 3 as 1 | 2 | 3,
  });

  const partsMap = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));

  // Get the UTC offset string for the target timezone
  const offsetFmt = new Intl.DateTimeFormat("en", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  });
  const offsetRaw =
    offsetFmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";

  // offsetRaw is like "GMT", "GMT+8", "GMT-5:30", "GMT+5:45"
  const offset = parseGmtOffset(offsetRaw);

  return `${partsMap.year}-${partsMap.month}-${partsMap.day}T${partsMap.hour}:${partsMap.minute}:${partsMap.second}.${partsMap.fractionalSecond}${offset}`;
}

/** Convert "GMT", "GMT+8", "GMT-5:30" → "+00:00", "+08:00", "-05:30" */
function parseGmtOffset(raw: string): string {
  if (raw === "GMT" || raw === "UTC") {
    return "+00:00";
  }

  const match = raw.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    return "+00:00";
  }

  const sign = match[1];
  const hours = match[2].padStart(2, "0");
  const minutes = (match[3] ?? "0").padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}
