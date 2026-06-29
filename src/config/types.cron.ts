// Defines cron scheduling configuration types.
import type { SecretInput } from "./types.secrets.js";

/** Error types that can trigger retries for one-shot jobs. */
export type CronRetryOn = "rate_limit" | "overloaded" | "network" | "timeout" | "server_error";

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
   * Minimum allowed interval between fires for recurring jobs (`every` and
   * `cron` schedules). Accepts a duration string (e.g. "30s", "5m", "1h") or a
   * number of milliseconds. Bare numbers are milliseconds. Two-layer
   * enforcement: create/update rejects schedules below the floor (early
   * feedback), and the scheduler paces re-arms at fire time so consecutive
   * fires stay at least this far apart (within a ~2s dispatch slack for timer
   * jitter), covering jobs that predate the limit and recurring transient-error
   * retries. Omit or set `0` to disable the floor (default). One-shot `at` jobs
   * (and their retries) are exempt.
   */
  minInterval?: string | number;
  /** Override default retry policy for one-shot jobs on transient errors. */
  retry?: CronRetryConfig;
  /**
   * @deprecated Legacy fallback webhook URL used by doctor to migrate stored
   * jobs with notify=true. Runtime delivery uses per-job delivery.mode="webhook"
   * with delivery.to, or delivery.completionDestination when preserving announce
   * delivery.
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
   * Run-history pruning controls. History is stored in SQLite; maxBytes is
   * retained for compatibility with older file-backed run logs.
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
