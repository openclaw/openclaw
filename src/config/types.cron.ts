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
   * Time budget (ms) for an isolated agent cron job to reach "runner started"
   * before the setup watchdog aborts it with
   * "isolated agent setup timed out before runner start".
   *
   * The watchdog protects the scheduler from genuinely-stuck agents, but the
   * fixed default can produce false timeouts when several heavy isolated jobs
   * start in the same window and contend on the single gateway event loop
   * during setup (runtime init, plugin load, CLI handshake), even on idle,
   * high-spec hosts.
   *
   * Accepts a value >= 1000 (clamped). Default: 60000 (60s).
   */
  agentSetupWatchdogMs?: number;
  /** Override default retry policy for one-shot jobs on transient errors. */
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
