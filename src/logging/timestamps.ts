export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function formatLocalIsoWithOffset(now: Date, timeZone?: string): string {
  const explicit = timeZone ?? process.env.TZ;
  const tz =
    explicit && isValidTimeZone(explicit)
      ? explicit
      : Intl.DateTimeFormat().resolvedOptions().timeZone;

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
