const CRON_POSITIVE_DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

export function parseCronPositiveDecimal(value: string): number | undefined {
  const trimmed = value.trim();
  if (!CRON_POSITIVE_DECIMAL_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
