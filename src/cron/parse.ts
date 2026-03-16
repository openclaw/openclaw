const ISO_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;

// Sep 9 2001 01:46:40 UTC in milliseconds — the smallest plausible
// "current-era" millisecond timestamp. Any all-digit value below this
// threshold looks like a Unix timestamp in *seconds*, not milliseconds,
// so we auto-promote it by multiplying by 1000. This prevents the year-58000+
// bug that arises when callers pass Unix seconds (e.g. 1714000000) and the
// parser blindly treats them as milliseconds.
const SECONDS_VS_MS_THRESHOLD = 1_000_000_000_000;

function normalizeUtcIso(raw: string) {
  if (ISO_TZ_RE.test(raw)) {
    return raw;
  }
  if (ISO_DATE_RE.test(raw)) {
    return `${raw}T00:00:00Z`;
  }
  if (ISO_DATE_TIME_RE.test(raw)) {
    return `${raw}Z`;
  }
  return raw;
}

export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      // Auto-detect Unix-seconds timestamps: values below the threshold are
      // too small to be a reasonable millisecond epoch but are valid seconds.
      // Multiplying by 1000 converts them to milliseconds. This fixes the
      // "year 58177" bug caused by mixing seconds and milliseconds.
      if (n < SECONDS_VS_MS_THRESHOLD) {
        return Math.floor(n) * 1000;
      }
      return Math.floor(n);
    }
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
