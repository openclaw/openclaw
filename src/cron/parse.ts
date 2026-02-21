const ISO_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;

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

// Threshold to distinguish seconds from milliseconds:
// 10_000_000_000 ms = Sat Apr 26 1970 17:46:40 UTC (clearly seconds)
// Any timestamp smaller than this is assumed to be in seconds.
const MS_THRESHOLD = 10_000_000_000;

export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      // If the number looks like seconds (< threshold), convert to milliseconds.
      // This handles Unix timestamps in seconds (e.g., 1739470800) which need
      // to be multiplied by 1000 for JavaScript Date operations.
      return n > MS_THRESHOLD ? Math.floor(n) : Math.floor(n * 1000);
    }
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
