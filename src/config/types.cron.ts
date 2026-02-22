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
   * Default deferWhileActive settings for all main-session cron jobs.
   * Individual jobs can override with their own deferWhileActive.
   * When set, cron jobs targeting the main session will be silently skipped
   * if the session received activity within quietMs milliseconds.
   */
  deferWhileActive?:
    | {
        /** Skip if last session activity was within this many ms. Default: 300000 (5 min). */
        quietMs?: number;
      }
    | false;
};
