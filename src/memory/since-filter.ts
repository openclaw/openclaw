const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_DAYS_RE = /^(\d+)d$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Parse "7d", "30d", "2026-02-25" into a cutoff Date.
 * Returns null if input is invalid.
 */
export function parseSince(since: string): Date | null {
  const trimmed = since.trim();
  if (!trimmed) {
    return null;
  }

  const relativeMatch = RELATIVE_DAYS_RE.exec(trimmed);
  if (relativeMatch) {
    const days = Number(relativeMatch[1]);
    if (!Number.isInteger(days) || days < 0 || days > 36500) {
      return null;
    }
    return new Date(Date.now() - days * DAY_MS);
  }

  const dateMatch = DATE_RE.exec(trimmed);
  if (!dateMatch) {
    return null;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

/**
 * Build a SQL WHERE clause fragment for source_date filtering.
 * Evergreen files (source_date IS NULL) are always included.
 * Returns { sql: string, params: string[] }
 */
export function buildSinceClause(
  since: string,
  columnName = "source_date",
): { sql: string; params: string[] } | null {
  const cutoff = parseSince(since);
  if (!cutoff) {
    return null;
  }
  return {
    sql: ` AND (${columnName} >= ? OR ${columnName} IS NULL)`,
    params: [toDateOnlyString(cutoff)],
  };
}
