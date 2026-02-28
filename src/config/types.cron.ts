export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /**
   * Deprecated legacy fallback webhook URL used only for stored jobs with notify=true.
   * Prefer per-job delivery.mode="webhook" with delivery.to.
   */
  webhook?: string;
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: string;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * Default: "24h".
   */
  sessionRetention?: string | false;
  /**
   * Run-log pruning controls for `cron/runs/<jobId>.jsonl`.
   * Defaults: `maxBytes=2_000_000`, `keepLines=2000`.
   */
  runLog?: {
    maxBytes?: number | string;
    keepLines?: number;
  };
  /**
   * Custom exponential backoff schedule (array of millisecond delays) for
   * consecutive cron execution errors. Each entry corresponds to the Nth
   * consecutive error. After the last entry the delay stays constant.
   * Default: [30000, 60000, 300000, 900000, 3600000]
   */
  retryBackoff?: number[];
  /**
   * How long (in ms) a job's `runningAtMs` marker must be stale before the
   * scheduler clears it as "stuck". Default: 7200000 (2 hours).
   */
  stuckRunTimeoutMs?: number;
};
