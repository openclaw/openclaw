import type { SecretInput } from "./types.secrets.js";

/** Error types that can trigger retries for one-shot and recurring jobs on transient errors. */
export type CronRetryOn = "rate_limit" | "overloaded" | "network" | "timeout" | "server_error";

export type CronRetryConfig = {
  /**
   * Max retries on transient errors. For one-shot jobs, exceeding this
   * disables the job permanently. For recurring jobs, exceeding this stops
   * scheduling at the configured backoff slot; the next run is then the
   * later of the natural cron/`every` slot and the backoff floor.
   * Default: 3.
   */
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
  includeSkipped?: boolean;
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
  /**
   * Override default retry policy for transient errors. Applies to one-shot
   * jobs and to recurring jobs whose error falls in `retryOn` while
   * consecutiveErrors <= maxAttempts. Once a recurring job exhausts its
   * retry budget, the next run is the later of its natural cron/`every`
   * slot and the backoff floor.
   */
  retry?: CronRetryConfig;
  /**
   * @deprecated Legacy fallback webhook URL used only for stored jobs with notify=true.
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
};
