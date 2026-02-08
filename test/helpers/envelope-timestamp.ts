import {
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../../src/infra/format-time/format-datetime.js";

type EnvelopeTimestampZone = string;

export function formatEnvelopeTimestamp(date: Date, zone: EnvelopeTimestampZone = "utc"): string {
  const normalized = zone.trim().toLowerCase();
  if (normalized === "utc" || normalized === "gmt") {
    return formatUtcTimestamp(date);
  }
  if (normalized === "local" || normalized === "host") {
    return formatZonedTimestamp(date) ?? formatUtcTimestamp(date);
  }
  return formatZonedTimestamp(date, { timeZone: zone }) ?? formatUtcTimestamp(date);
}

export function formatLocalEnvelopeTimestamp(date: Date): string {
  return formatEnvelopeTimestamp(date, "local");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
