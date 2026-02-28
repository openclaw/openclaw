/**
 * CronPreflightGate Handler
 *
 * Validates system ledger health and commits to a specific cron task
 * before any tool execution. Fail-closed: any validation error → ESCALATE.
 */

import type { CronTaskId } from "./cron-task.js";
import { assertValidCronTask } from "./cron-task.js";
import { verifyLedgerInvariants } from "./ledger-verification.js";
import type { CronDecisionRecord } from "./decision-cron.js";
import {
  createCronDecisionRecord,
  lockCronTask,
} from "./decision-cron.js";

/**
 * Escalation outcome when cron state is invalid.
 * Operator intervention required.
 */
export interface EscalateCronStateInvalid {
  outcome: "ESCALATE_CRON_STATE_INVALID";
  reason:
    | "LEDGER_VERIFICATION_FAILED"
    | "LEDGER_FILE_NOT_FOUND"
    | "LEDGER_READ_ERROR"
    | "INVALID_JSONL_FORMAT"
    | "EMPTY_LEDGER"
    | "DUPLICATE_RUN_IDS"
    | "BASELINE_GATED_MISMATCH"
    | "MISSING_REQUIRED_FIELD"
    | "TASK_SELECTION_AMBIGUOUS"
    | "TASK_ENUM_MISMATCH"
    | "UNKNOWN_LEDGER_ERROR";
  /** Detailed error message for operator */
  details: string;
  /** Suggested remediation */
  remediation: string;
  /** Timestamp of escalation */
  escalated_at: string;
}

/**
 * Success outcome when validation passes and task is locked.
 */
export interface ProceedOutcome {
  outcome: "PROCEED";
  decision_record: CronDecisionRecord;
}

/**
 * Union of all possible CronPreflightGate outcomes.
 */
export type CronPreflightOutcome = EscalateCronStateInvalid | ProceedOutcome;

/**
 * CronPreflightGate validator class.
 *
 * Runs before any tool dispatch to ensure:
 * 1. Ledger state is valid and consistent
 * 2. Cron task is unambiguously selected and locked
 */
export class CronPreflightGate {
  /**
   * Validate ledger and select cron task.
   * Fail-closed: any error returns ESCALATE.
   *
   * @param runId - Unique identifier for this run
   * @param ledgerPath - Path to the ledger file
   * @param selectedTask - Selected cron task ID
   * @returns Decision outcome: PROCEED with locked task or ESCALATE
   */
  async validate(
    runId: string,
    ledgerPath: string,
    selectedTask: string
  ): Promise<CronPreflightOutcome> {
    const escalatedAt = new Date().toISOString();

    // Step 1: Verify ledger using structured API
    let ledgerVerification;
    try {
      ledgerVerification = await verifyLedgerInvariants(ledgerPath, 50);
    } catch (err) {
      // Fail-closed: unexpected error → ESCALATE
      return {
        outcome: "ESCALATE_CRON_STATE_INVALID",
        reason: "UNKNOWN_LEDGER_ERROR",
        details: `Unexpected error during ledger verification: ${err instanceof Error ? err.message : String(err)}`,
        remediation:
          "Check ledger file integrity and permissions. Review error logs for details.",
        escalated_at: escalatedAt,
      };
    }

    // Step 2: Check if ledger verification passed
    if (!ledgerVerification.valid) {
      const failureReason = ledgerVerification.failure_reason;

      // Map ledger failure reasons to escalation reasons
      const escalationReasonMap: Record<
        string,
        EscalateCronStateInvalid["reason"]
      > = {
        FILE_NOT_FOUND: "LEDGER_FILE_NOT_FOUND",
        FILE_READ_ERROR: "LEDGER_READ_ERROR",
        INVALID_JSONL_FORMAT: "INVALID_JSONL_FORMAT",
        EMPTY_LEDGER: "EMPTY_LEDGER",
        DUPLICATE_RUN_IDS: "DUPLICATE_RUN_IDS",
        BASELINE_GATED_MISMATCH: "BASELINE_GATED_MISMATCH",
        MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
      };

      const escalationReason =
        escalationReasonMap[failureReason ?? "UNKNOWN"] ??
        "LEDGER_VERIFICATION_FAILED";

      return {
        outcome: "ESCALATE_CRON_STATE_INVALID",
        reason: escalationReason,
        details:
          ledgerVerification.error_message ??
          "Ledger verification failed for unknown reason",
        remediation:
          "Inspect docs/internal/clarityburst-usage-ledger.jsonl. Verify all entries are valid JSONL and contain required fields (runId, workloadId, mode). Fix any corrupt entries and retry.",
        escalated_at: escalatedAt,
      };
    }

    // Step 3: Validate selectedTask against closed enum
    let validatedTask: CronTaskId;
    try {
      validatedTask = assertValidCronTask(selectedTask);
    } catch (err) {
      // Task not in enum → ESCALATE
      return {
        outcome: "ESCALATE_CRON_STATE_INVALID",
        reason: "TASK_ENUM_MISMATCH",
        details: `Selected task "${selectedTask}" is not in the closed enum. ${err instanceof Error ? err.message : ""}`,
        remediation:
          "Ensure selectedTask is one of the valid cron task IDs. Check src/clarityburst/cron-task.ts for the complete list.",
        escalated_at: escalatedAt,
      };
    }

    // Step 4: Create decision record with verified ledger + locked task
    const decisionRecord = createCronDecisionRecord(
      runId,
      ledgerVerification
    );

    // Step 5: Lock the task (immutable once set)
    try {
      lockCronTask(decisionRecord, validatedTask);
    } catch (err) {
      // Should not happen on first lock, but fail-closed if it does
      return {
        outcome: "ESCALATE_CRON_STATE_INVALID",
        reason: "UNKNOWN_LEDGER_ERROR",
        details: `Unexpected error locking cron task: ${err instanceof Error ? err.message : String(err)}`,
        remediation: "System error during task locking. Contact support.",
        escalated_at: escalatedAt,
      };
    }

    // Step 6: Return success outcome with locked decision record
    return {
      outcome: "PROCEED",
      decision_record: decisionRecord,
    };
  }
}
