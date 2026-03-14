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
  mode?: "announce" | "webhook";
  accountId?: string;
};

export type CronFailureDestinationConfig = {
  channel?: string;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

/** A script to run at a cron lifecycle hook point. */
export type CronHookEntry = {
  /** Path to hook script (.cjs/.ts), workspace-relative or absolute. */
  script: string;
  /** Execution priority — lower numbers run first (default: 10). */
  priority?: number;
  /** Per-hook timeout in milliseconds (default: 10000). */
  timeoutMs?: number;
  /** Only run this hook when the filter criteria match. */
  filter?: {
    workflow?: string[];
    jobId?: string[];
    /** Match by job name (case-insensitive substring match). */
    jobName?: string[];
    agentId?: string[];
  };
};

/**
 * Lifecycle hook points for cron job execution:
 * - `beforeRun`: fires before the job executes; may abort the job via `{ abort: true }`.
 * - `afterComplete`: fires only when the job succeeds (status "ok").
 * - `onFailure`: fires only when the job fails (status "error").
 * - `afterRun`: always fires regardless of outcome (like a `finally` block),
 *   including after `beforeRun` aborts. Use for cleanup, audit, or metrics.
 */
export type CronLifecycleHookPoint = "beforeRun" | "afterComplete" | "onFailure" | "afterRun";

/** Global cron lifecycle hooks registered in openclaw.json cron section. */
export type CronHooksConfig = {
  [K in CronLifecycleHookPoint]?: CronHookEntry[];
};

/** Per-job hook overrides stored in jobs.json. */
export type CronJobHooksConfig = {
  [K in CronLifecycleHookPoint]?: string[];
} & {
  /** Hook points for which global hooks should be skipped. */
  skipGlobal?: CronLifecycleHookPoint[];
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
  /** Lifecycle hooks that run at defined points during cron job execution. */
  hooks?: CronHooksConfig;
};
