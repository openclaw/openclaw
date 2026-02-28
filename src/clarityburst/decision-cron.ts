/**
 * Decision Record Extensions for Cron Tasks
 *
 * Extends the base decision record with cron-specific fields
 * and immutability enforcement for task selection.
 */

import type { CronTaskId } from "./cron-task.js";
import type { LedgerVerificationResult } from "./ledger-verification.js";

/**
 * Extended decision record with cron task commitment.
 * Immutable once task is set; cannot be changed during run lifetime.
 */
export interface CronDecisionRecord {
  /** Unique run identifier */
  runId: string;

  /** Cron task selected during preflight gate (MANDATORY) */
  nextCronTask?: CronTaskId;

  /** When the task was committed (ISO 8601 timestamp) */
  task_committed_at?: string;

  /** Ledger verification result */
  ledger_verification: {
    valid: boolean;
    entries_checked: number;
    verified_at: string;
  };

  /** Override outcomes for each stage (populated downstream) */
  stage_outcomes?: Record<string, unknown>;

  /** Final execution outcome */
  execution_outcome?: {
    success: boolean;
    error?: string;
  };
}

/**
 * Lock the cron task selection for this run.
 * Once locked, cannot be changed. Fail-closed: errors if already locked.
 *
 * @param record - The decision record to update
 * @param taskId - The task ID to lock
 * @throws Error if task is already locked to a different value
 */
export function lockCronTask(
  record: CronDecisionRecord,
  taskId: CronTaskId
): void {
  if (record.nextCronTask !== undefined) {
    throw new Error(
      `CronTask already locked to ${record.nextCronTask}; cannot change to ${taskId}`
    );
  }
  record.nextCronTask = taskId;
  record.task_committed_at = new Date().toISOString();
}

/**
 * Assert that a cron task has been selected and locked.
 * Fail-closed: throws if task not set.
 *
 * @param record - The decision record to check
 * @returns The locked CronTaskId
 * @throws Error if nextCronTask is not set
 */
export function assertCronTaskLocked(record: CronDecisionRecord): CronTaskId {
  if (!record.nextCronTask) {
    throw new Error(
      "CronTask not selected; preflight gate must run before tool dispatch"
    );
  }
  return record.nextCronTask;
}

/**
 * Type guard to check if a record is a CronDecisionRecord
 * with ledger verification data.
 *
 * @param record - The object to check
 * @returns true if the record has cron-required fields
 */
export function isCronDecisionRecord(record: unknown): record is CronDecisionRecord {
  if (!record || typeof record !== "object") {
    return false;
  }

  const obj = record as Record<string, unknown>;

  // Check for required fields
  if (!obj.runId || typeof obj.runId !== "string") {
    return false;
  }

  if (!obj.ledger_verification || typeof obj.ledger_verification !== "object") {
    return false;
  }

  const lv = obj.ledger_verification as Record<string, unknown>;
  if (
    typeof lv.valid !== "boolean" ||
    typeof lv.entries_checked !== "number" ||
    typeof lv.verified_at !== "string"
  ) {
    return false;
  }

  return true;
}

/**
 * Create a new CronDecisionRecord with ledger verification data.
 *
 * @param runId - Unique run identifier
 * @param ledgerVerification - Result from ledger verification
 * @returns A new CronDecisionRecord
 */
export function createCronDecisionRecord(
  runId: string,
  ledgerVerification: LedgerVerificationResult
): CronDecisionRecord {
  return {
    runId,
    ledger_verification: {
      valid: ledgerVerification.valid,
      entries_checked: ledgerVerification.entries_checked,
      verified_at: ledgerVerification.verified_at,
    },
  };
}
