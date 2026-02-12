export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * Default: "24h".
   */
  sessionRetention?: string | false;
  /**
   * Maximum number of completed run sessions to keep per cron job.
   * When a job exceeds this cap the oldest runs are removed, even if they
   * are still within the retention window. This prevents unbounded growth
   * of sessions.json when jobs fire frequently.
   * Default: 50.
   */
  maxRunsPerJob?: number;
};
