import type { CronDeliveryTrace, CronRunOutcome, CronRunTelemetry } from "../types.js";

export type RunCronAgentTurnResult = {
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /**
   * `true` when the isolated runner already handled the run's user-visible
   * delivery outcome, either through runner fallback delivery, explicit
   * suppression, or a matching message-tool send that already reached the
   * target.
   */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
  /**
   * Explicit policy for whether this result should be surfaced as a system
   * event in the resolved main-session destination for the hook. For explicit
   * agent hooks, that destination may be the target agent's main session.
   * When unset, shared-hook fallback uses a compatibility bridge based on
   * `delivered`, `deliveryAttempted`, and `deliver` to decide.
   */
  announceToMain?: boolean;
  delivery?: CronDeliveryTrace;
} & CronRunOutcome &
  CronRunTelemetry;
