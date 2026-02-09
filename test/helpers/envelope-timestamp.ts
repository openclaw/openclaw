import {
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../../src/infra/format-time/format-datetime.js";

type EnvelopeTimestampZone = string;

export function formatEnvelopeTimestamp(date: Date, zone: EnvelopeTimestampZone = "utc"): string {
  const normalized = zone.trim().toLowerCase();
  const weekday = (() => {
    try {
      if (normalized === "utc" || normalized === "gmt") {
        return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
      }
      if (normalized === "local" || normalized === "host") {
        return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
      }
      return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(date);
    } catch {
      return undefined;
    }
  })();

  if (normalized === "utc" || normalized === "gmt") {
    const ts = formatUtcTimestamp(date);
    return weekday ? `${weekday} ${ts}` : ts;
  }
  if (normalized === "local" || normalized === "host") {
    const ts = formatZonedTimestamp(date) ?? formatUtcTimestamp(date);
    return weekday ? `${weekday} ${ts}` : ts;
  }
  const ts = formatZonedTimestamp(date, { timeZone: zone }) ?? formatUtcTimestamp(date);
  return weekday ? `${weekday} ${ts}` : ts;
}

export function formatLocalEnvelopeTimestamp(date: Date): string {
  return formatEnvelopeTimestamp(date, "local");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
