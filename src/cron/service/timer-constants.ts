export const MAX_CRON_TIMER_DELAY_MS = 60_000;

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
export const MIN_REFIRE_GAP_MS = 2_000;

export const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;

export const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;

export const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2 * 60_000;
