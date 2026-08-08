// Defines cron scheduling configuration types.
import type { SecretInput } from "./types.secrets.js";
import type { SsrFPolicyConfig } from "./types.ssrf.js";

export type CronFailureAlertConfig = {
  enabled?: boolean;
  after?: number;
  cooldownMs?: number;
  includeSkipped?: boolean;
  mode?: "announce" | "webhook";
  accountId?: string;
  channel?: string;
  to?: string;
};

export type CronFailureDestinationConfig = {
  channel?: string;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

/**
 * Daily maintenance window for cron and heartbeat execution with hard role isolation.
 *
 * When the local wall clock is inside `window.start`..`window.end` (interpreted in
 * `window.timezone`, defaulting to `agents.defaults.userTimezone`), the cron service
 * defers scheduled and manual runs for any agent not listed in `maintenanceAgents`.
 * Heartbeat wakes for non-maintenance agents are also deferred through the new
 * `shouldDeferWake` maintenance branch. Deferred jobs are replayed in FIFO order
 * when the phase returns to normal.
 *
 * v2 only supports `start < end` (single-day window). Cross-midnight windows
 * (`start > end`) are rejected as invalid config; see the schema for the check.
 */
export type CronMaintenanceConfig = {
  /** Master switch. When false, the rest of the block is ignored. Default: false. */
  enabled?: boolean;
  /**
   * Local-time window that activates the maintenance phase.
   * `start` and `end` are `HH:MM` (24h) strings. v2 does not support cross-midnight
   * windows; if `start >= end` the schema rejects the block as invalid.
   */
  window?: {
    start?: string;
    end?: string;
    /**
     * IANA timezone or one of the magic strings "user" / "local".
     * Defaults to `agents.defaults.userTimezone` when omitted.
     */
    timezone?: string;
  };
  /**
   * Agent ids allowed to run during the maintenance phase. Any agent id not in
   * this list will be deferred (cron) or wake-deferred (heartbeat) for the
   * duration of the window. Omit or empty = all agents deferred.
   */
  maintenanceAgents?: readonly string[];
  /**
   * Whether `openclaw cron run <jobId>` and `openclaw automations run` may
   * bypass the maintenance gate when the window is active.
   * Default: false (operator-initiated runs respect the maintenance phase).
   */
  allowManualRun?: boolean;
};

export type CronConfig = {
  enabled?: boolean;
  triggers?: {
    enabled?: boolean;
  };
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: SecretInput;
  /** SSRF policy for all outbound cron webhook deliveries. */
  webhookSsrfPolicy?: SsrFPolicyConfig;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * A zero duration (e.g. "0h") also disables pruning; negative durations are invalid.
   * Default: "24h".
   */
  sessionRetention?: string | false;
  failureAlert?: CronFailureAlertConfig;
  maintenance?: CronMaintenanceConfig;
};
