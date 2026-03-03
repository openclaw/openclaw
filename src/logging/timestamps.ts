export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve timezone configuration value to an IANA timezone string.
 * - "utc" → "UTC"
 * - "local" → system local timezone
 * - IANA string → validated and returned as-is
 * - undefined/invalid → falls back to process.env.TZ or system local
 */
export function resolveTimezone(timezone?: string): string {
  if (timezone === "utc") {
    return "UTC";
  }
  if (timezone === "local") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (timezone && isValidTimeZone(timezone)) {
    return timezone;
  }
  // Fallback: check TZ env var, then system local
  const envTz = process.env.TZ;
  if (envTz && isValidTimeZone(envTz)) {
    return envTz;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatLocalIsoWithOffset(now: Date, timeZone?: string): string {
  const tz = resolveTimezone(timeZone);

  const fmt = new Intl.DateTimeFormat("en", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    fractionalSecondDigits: 3 as 1 | 2 | 3,
    timeZoneName: "longOffset",
  });

  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));

  const offsetRaw = parts.timeZoneName ?? "GMT";
  const offset = offsetRaw === "GMT" ? "+00:00" : offsetRaw.slice(3);

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}
