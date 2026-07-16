import { asFiniteNumberInRange, parseStrictNonNegativeInteger } from "../shared/number-coercion.js";

const RETRY_AFTER_HEADER_DELAY_RE = /^\d+$/;
const RETRY_AFTER_HTTP_DATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const MAX_SAFE_RETRY_AFTER_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

/** Parses an RFC Retry-After header as delay seconds or an IMF-fixdate. */
export function parseRetryAfterHeaderSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (RETRY_AFTER_HEADER_DELAY_RE.test(trimmed)) {
    return asFiniteNumberInRange(parseStrictNonNegativeInteger(trimmed), {
      min: 0,
      max: MAX_SAFE_RETRY_AFTER_SECONDS,
    });
  }
  if (!RETRY_AFTER_HTTP_DATE_RE.test(trimmed)) {
    return undefined;
  }
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) && Number.isFinite(now)
    ? Math.max(0, (retryAt - now) / 1000)
    : undefined;
}
