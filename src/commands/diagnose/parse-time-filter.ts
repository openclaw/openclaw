// Duration suffix → multiplier in milliseconds.
// Accepts: ms (millisecond), s (second), m (minute), h (hour), d (day), w (week).
const DURATION_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d|w)$/;

export interface TimeFilter {
  /** Absolute epoch milliseconds — include entries with timestamp >= sinceMs. */
  sinceMs: number;
  /** Human-readable label (e.g. "last 2h", "since 2026-04-20T00:00:00.000Z") for the diagnostic context. */
  label: string;
}

/**
 * Parse a duration string like "30m", "2h", "7d" into milliseconds.
 * Returns null if the string is not a valid duration.
 */
export function parseDurationMs(value: string): number | null {
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const n = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2] ?? "";
  const multiplier = DURATION_MULTIPLIERS[unit];
  if (multiplier === undefined) {
    return null;
  }
  return n * multiplier;
}

/**
 * Resolve --since / --last options into an absolute epoch ms cutoff plus a
 * display label. Throws on invalid input or when both options are set.
 *
 *   --last <duration>  → sinceMs = now - duration
 *   --since <duration> → sinceMs = now - duration  (same as --last)
 *   --since <iso-date> → sinceMs = Date.parse(iso-date)
 *
 * Returns null when neither option is provided (no filter).
 */
export function parseTimeFilter(
  opts: { since?: string; last?: string },
  nowMs: number = Date.now(),
): TimeFilter | null {
  if (opts.since !== undefined && opts.last !== undefined) {
    throw new Error("--since and --last cannot both be specified. Choose one.");
  }

  if (opts.last !== undefined) {
    const durationMs = parseDurationMs(opts.last);
    if (durationMs === null) {
      throw new Error(
        `Invalid --last duration: "${opts.last}". Expected format like "30m", "2h", "7d" (units: ms, s, m, h, d, w).`,
      );
    }
    return { sinceMs: nowMs - durationMs, label: `last ${opts.last}` };
  }

  if (opts.since !== undefined) {
    // Try duration first (e.g. "--since 2h" behaves like "--last 2h").
    const durationMs = parseDurationMs(opts.since);
    if (durationMs !== null) {
      return { sinceMs: nowMs - durationMs, label: `last ${opts.since}` };
    }
    // Otherwise parse as an absolute timestamp.
    const parsed = Date.parse(opts.since);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `Invalid --since value: "${opts.since}". Expected an ISO timestamp (e.g. "2026-04-20", "2026-04-20T10:00:00") or a duration (e.g. "2h", "7d").`,
      );
    }
    return { sinceMs: parsed, label: `since ${new Date(parsed).toISOString()}` };
  }

  return null;
}
