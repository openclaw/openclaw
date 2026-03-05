import type { SecretInput } from "./types.secrets.js";

/** Error types that can trigger retries for one-shot jobs. */
export type CronRetryOn = "rate_limit" | "network" | "timeout" | "server_error";

export type CronRetryConfig = {
  /** Max retries for transient errors before permanent disable (default: 3). */
  maxAttempts?: number;
  /** Backoff delays in ms for each retry attempt (default: [30000, 60000, 300000]). */
  backoffMs?: number[];
  /** Error types to retry; omit to retry all transient types. */
  retryOn?: CronRetryOn[];
};

export type CronFailureAlertConfig = {
  enabled?: boolean;
  after?: number;
  cooldownMs?: number;
  mode?: "announce" | "webhook";
  accountId?: string;
};

export type CronFailureDestinationConfig = {
  channel?: string;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /** Override default retry policy for one-shot jobs on transient errors. */
  retry?: CronRetryConfig;
  /**
   * Deprecated legacy fallback webhook URL used only for stored jobs with notify=true.
   * Prefer per-job delivery.mode="webhook" with delivery.to.
   */
  webhook?: string;
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: SecretInput;
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
  failureAlert?: CronFailureAlertConfig;
  /** Default destination for failure notifications across all cron jobs. */
  failureDestination?: CronFailureDestinationConfig;
  /**
   * Default IANA timezone for cron expressions that do not specify an explicit
   * tz field (e.g. "America/New_York", "Europe/Paris", "Asia/Tokyo").
   * Falls back to the gateway process timezone when not set.
   * Common cause of "hours-off" scheduling: containers default to UTC while
   * the operator writes cron expressions in their local timezone.
   */
  timezone?: string;
  /** Internet time-sync drift detection to catch misconfigured host clocks. */
  timeSyncCheck?: {
    /** Enable startup + periodic drift checks (default: true). */
    enabled?: boolean;
    /** URL to query for a Date header (default: "https://www.google.com"). */
    source?: string;
    /** Maximum acceptable drift in seconds (default: 60). */
    thresholdSeconds?: number;
    /** Periodic re-check interval in minutes; 0 disables periodic checks (default: 60). */
    intervalMinutes?: number;
    /** Block gateway startup when drift exceeds threshold (default: false). */
    blockStartup?: boolean;
  };
};
