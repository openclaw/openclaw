import {
  bucketRelativeTimeMs,
  formatByteSize,
  formatCompactTokenCount as formatTokenUnits,
  type RelativeTimeUnit,
} from "@openclaw/normalization-core";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { DurationPart } from "../../../src/infra/format-time/format-duration-internal.ts";
import { i18n, t } from "../i18n/index.ts";
import { formatUiError } from "./format-error.ts";

export { formatByteSize } from "@openclaw/normalization-core";

export function formatResourceBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "tera" || value < 10 ? 1 : 0),
  });
}

export function formatCountdown(deadlineMs: number, nowMs: number, padMinutes = false): string {
  const totalSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
  const minutes = String(Math.floor(totalSeconds / 60));
  return `${padMinutes ? minutes.padStart(2, "0") : minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

let localeFormatters:
  | {
      locale: string;
      units: Partial<
        Record<`${DurationPart["unit"] | "byte"}:${"narrow" | "long"}`, Intl.NumberFormat>
      >;
      relative?: Intl.RelativeTimeFormat;
      numbers: Map<string, Intl.NumberFormat>;
    }
  | undefined;

function getLocaleFormatters() {
  const locale = i18n.getLocale();
  // Keep one locale's closed unit set; switching languages releases the old
  // formatters without retaining labels or subscribing to component lifetimes.
  if (localeFormatters?.locale !== locale) {
    localeFormatters = { locale, units: {}, numbers: new Map() };
  }
  return localeFormatters;
}

export function formatUnit({
  value,
  unit,
  unitDisplay = "narrow",
}: (DurationPart | { value: number; unit: "byte" }) & { unitDisplay?: "narrow" | "long" }): string {
  const formatters = getLocaleFormatters();
  const key = `${unit}:${unitDisplay}` as const;
  return (formatters.units[key] ??= new Intl.NumberFormat(formatters.locale, {
    style: "unit",
    unit,
    unitDisplay,
    maximumFractionDigits: 0,
  })).format(value);
}

function formatRelative(value: number, unit: RelativeTimeUnit): string {
  const formatters = getLocaleFormatters();
  return (formatters.relative ??= new Intl.RelativeTimeFormat(formatters.locale, {
    numeric: "auto",
    style: "narrow",
  })).format(value, unit);
}

export function formatTimeAgo(
  durationMs: number | null | undefined,
  options: { suffix?: boolean; fallback?: string } = {},
): string {
  const fallback = options.fallback ?? t("common.unknown");
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  const { value, unit } = bucketRelativeTimeMs(durationMs);
  if (unit === "second" && options.suffix !== false) {
    return t("common.justNow");
  }
  return options.suffix === false ? formatUnit({ value, unit }) : formatRelative(-value, unit);
}

export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options: { fallback?: string; suffix?: boolean } = {},
): string {
  const fallback = options.fallback ?? t("common.na");
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return fallback;
  }

  const diff = timestampMs - Date.now();
  const isPast = diff <= 0;
  const { value, unit } = bucketRelativeTimeMs(Math.abs(diff));
  if (unit === "second") {
    if (options.suffix === false) {
      return formatUnit({ value, unit });
    }
    return isPast ? t("common.justNow") : formatRelative(value, unit);
  }

  const signedValue = isPast ? -value : value;
  return options.suffix === false ? formatUnit({ value, unit }) : formatRelative(signedValue, unit);
}

export function formatUnknownText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back when value is not JSON-serializable.
  }
  if (value instanceof Error) {
    return formatUiError(value);
  }
  return Object.prototype.toString.call(value);
}

export function formatMs(ms?: number | null): string {
  return createMsFormatter()(ms);
}

/** {@link formatMs} for tight rows: today reads as the time alone, this year omits the year. */
export function formatCompactMs(ms?: number | null): string {
  return createCompactMsFormatter()(ms);
}

const DEFAULT_MS_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};
const YEAR_FIELDS = new Set(["era", "year"]);
const DATE_FIELDS = new Set([...YEAR_FIELDS, "month", "day", "weekday", "dateStyle"]);

/** Same-day timestamps keep only the caller's time fields, and same-year ones drop the year;
 * anything else keeps every field. Options must include time fields and the viewer's zone.
 */
export function createCompactMsFormatter(
  options: Intl.DateTimeFormatOptions = DEFAULT_MS_FORMAT,
  fallback?: string,
): (ms?: number | null) => string {
  const without = (fields: Set<string>) =>
    Object.fromEntries(Object.entries(options).filter(([field]) => !fields.has(field)));
  const formatters = {
    full: createMsFormatter(options, fallback),
    // Style presets choose their own year, so only explicit fields can drop it.
    year: options.dateStyle ? undefined : createMsFormatter(without(YEAR_FIELDS), fallback),
    day: createMsFormatter(without(DATE_FIELDS), fallback),
  };
  return (ms) => {
    const timestampMs = asDateTimestampMs(ms);
    if (timestampMs === undefined) {
      return formatters.full(ms);
    }
    const date = new Date(timestampMs);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return formatters.day(timestampMs);
    }
    const sameYear = date.getFullYear() === now.getFullYear() ? formatters.year : undefined;
    return (sameYear ?? formatters.full)(timestampMs);
  };
}

/** Reuse within one render so the next render picks up locale and system timezone changes.
 * Explicit options replace the default minute-precision fields.
 */
export function createMsFormatter(
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
): (ms?: number | null) => string {
  let formatter: Intl.DateTimeFormat | undefined;
  let locale: string | undefined;
  return (ms) => {
    const timestampMs = asDateTimestampMs(ms);
    if (timestampMs === undefined) {
      return fallback ?? t("common.na");
    }
    if (locale !== i18n.getLocale()) {
      locale = i18n.getLocale();
      formatter = undefined;
    }
    formatter ??= new Intl.DateTimeFormat(locale, options ?? DEFAULT_MS_FORMAT);
    return formatter.format(new Date(timestampMs));
  };
}

function calendarFormatter(
  method: "toLocaleDateString" | "toLocaleTimeString" | "toLocaleString",
  defaultOptions?: () => Intl.DateTimeFormatOptions,
) {
  return (
    ms?: number | null,
    options?: Intl.DateTimeFormatOptions,
    fallback = t("common.na"),
  ): string => {
    const timestampMs = asDateTimestampMs(ms);
    return timestampMs === undefined
      ? fallback
      : new Date(timestampMs)[method](
          i18n.getLocale(),
          defaultOptions && options == null ? defaultOptions() : options,
        );
  };
}

export const formatDateMs = calendarFormatter("toLocaleDateString");
export const formatTimeMs = calendarFormatter("toLocaleTimeString", () => ({ timeStyle: "short" }));
export const formatDateTimeMs = calendarFormatter("toLocaleString");

export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) {
    return t("common.none");
  }
  return values.filter((v): v is string => Boolean(v && v.trim())).join(", ");
}

export function clampText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, max - 1))}…`;
}

export function truncateText(value: string, max: number) {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: truncateUtf16Safe(value, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Formats USD using the UI locale, retaining the caller's scale-specific precision. */
export function formatCost(cost: number | null | undefined): string {
  const value = cost != null && Number.isFinite(cost) && cost !== 0 ? cost : 0;
  const digits = value === 0 ? 2 : value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return formatUsd(value, digits);
}

export function formatUsd(value: number, digits = 2): string {
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  const cache = getLocaleFormatters();
  const key = JSON.stringify(options);
  let formatter = cache.numbers.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(cache.locale, options);
    cache.numbers.set(key, formatter);
  }
  return formatter.format(value);
}

export function formatDateTimeRangeMs(first: number, last: number): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatRange(first, last);
}

// Keep token presentation consistent across UI session and usage surfaces.
export function formatCompactTokenCount(
  tokens: number | null | undefined,
  options: {
    thousandsPrecision?: 0 | 1;
    thousandsSuffix?: string;
    trimTrailingZero?: boolean;
  } = {},
): string {
  if (tokens == null || !Number.isFinite(tokens)) {
    return "0";
  }
  return formatTokenUnits(tokens, {
    thousandsPrecision: options.thousandsPrecision,
    thousandsSuffix: options.thousandsSuffix,
    millionsSuffix: "M",
    trimTrailingZero: options.trimTrailingZero ?? true,
    maxUnit: "billion",
  });
}

export function formatContextTokenCapacity(tokens: number, thousandsPrecision: 0 | 1 = 1): string {
  if (tokens < 1_000_000) {
    return formatCompactTokenCount(tokens, { thousandsPrecision });
  }
  return `${Math.floor(tokens / 100_000) / 10}M`;
}
