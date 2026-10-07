export const DEFAULT_CRON_ENABLED = true;
/** Default maximum number of cron jobs allowed to run at once. */
export const DEFAULT_CRON_MAX_CONCURRENT_RUNS = 8;
const DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS = 30_000;

/**
 * Resolves cron concurrency, flooring finite values and clamping to at least one.
 * EDP: `OPENCLAW_CRON_MAX_CONCURRENT_RUNS` restores the operator cap that the
 * removed `cron.maxConcurrentRuns` config key used to provide.
 */
export function resolveCronMaxConcurrentRuns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_CRON_MAX_CONCURRENT_RUNS?.trim();
  if (!raw) {
    return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

/** Resolves the minimum cadence for trigger-bearing cron jobs. */
export function resolveCronTriggerMinIntervalMs(): number {
  return DEFAULT_CRON_TRIGGER_MIN_INTERVAL_MS;
}
