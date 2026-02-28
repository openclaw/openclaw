/**
 * ClarityBurst module exports
 *
 * Central export point for all ClarityBurst components.
 */

// Ledger verification API
export {
  verifyLedgerInvariants,
  type LedgerVerificationResult,
  type LedgerVerificationFailureReason,
} from "./ledger-verification.js";

// Cron task enum and registry
export {
  type CronTaskId,
  CRON_TASK_IDS,
  isValidCronTaskId,
  type RiskClass,
  type CronTaskMetadata,
  CRON_TASK_REGISTRY,
  assertValidCronTask,
  getCronTaskMetadata,
} from "./cron-task.js";

// Decision record extensions
export {
  type CronDecisionRecord,
  lockCronTask,
  assertCronTaskLocked,
  isCronDecisionRecord,
  createCronDecisionRecord,
} from "./decision-cron.js";

// CronPreflightGate handler
export {
  type EscalateCronStateInvalid,
  type ProceedOutcome,
  type CronPreflightOutcome,
  CronPreflightGate,
} from "./cron-preflight-gate.js";

// Cron dispatch checker for TOOL_DISPATCH_GATE integration
export {
  isCronMode,
  type CronPreflightCheckOutcome,
  checkCronDispatchCapability,
} from "./cron-dispatch-checker.js";
