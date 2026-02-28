/**
 * Cron Dispatch Checker
 *
 * Encapsulates cron mode detection, task locking validation, and capability-based
 * access control for tool dispatch in cron context. Fail-closed: any validation
 * error blocks tool dispatch.
 */

import type { CronDecisionRecord } from "./decision-cron.js";
import {
  isCronDecisionRecord,
  assertCronTaskLocked,
} from "./decision-cron.js";
import type { CronTaskId } from "./cron-task.js";
import {
  getCronTaskMetadata,
} from "./cron-task.js";

/**
 * Type guard: check if run context indicates cron mode.
 * Cron mode is detected from decision record presence or explicit mode flag.
 *
 * @param context - The dispatch context
 * @returns true if in cron mode
 */
export function isCronMode(context: unknown): boolean {
  if (!context || typeof context !== "object") {
    return false;
  }

  const ctx = context as Record<string, unknown>;
  
  // Check for explicit cron mode flag
  if (ctx.cronMode === true) {
    return true;
  }

  // Check for CronDecisionRecord in context
  if (ctx.cronDecision && isCronDecisionRecord(ctx.cronDecision)) {
    return true;
  }

  return false;
}

/**
 * Cron preflight check outcome
 */
export interface CronPreflightCheckOutcome {
  allowed: boolean;
  reason?: string;
  lockedTask?: CronTaskId;
  escalationReason?: string;
}

/**
 * Performs cron-specific preflight validation and capability checking.
 *
 * When in cron mode:
 * 1. Requires CronDecisionRecord to be present (fail-closed)
 * 2. Asserts cron task is locked via assertCronTaskLocked()
 * 3. Checks if requested capability is in task's requiredCapabilities
 * 4. Deny-by-default: if capability NOT in required set → REJECT
 *
 * When not in cron mode:
 * - Passes through (no cron checks applied)
 *
 * @param context - The dispatch context (may contain cronDecision, cronMode)
 * @param requestedCapability - The capability being requested (e.g., "shell", "file_system", "network")
 * @returns Outcome with allowed flag and reason
 */
export function checkCronDispatchCapability(
  context: unknown,
  requestedCapability: string
): CronPreflightCheckOutcome {
  // If not in cron mode, no cron checks needed
  if (!isCronMode(context)) {
    return { allowed: true };
  }

  // ===== CRON MODE ACTIVE =====

  // Step 1: Require CronDecisionRecord to be present
  if (!context || typeof context !== "object") {
    return {
      allowed: false,
      reason: "Cron mode requires locked task; preflight gate not executed",
      escalationReason: "Missing or invalid context in cron mode",
    };
  }

  const ctx = context as Record<string, unknown>;
  const cronDecision = ctx.cronDecision;

  if (!isCronDecisionRecord(cronDecision)) {
    return {
      allowed: false,
      reason: "Cron mode requires locked task; preflight gate not executed",
      escalationReason: "CronDecisionRecord not present",
    };
  }

  // Step 2: Assert task is locked
  let lockedTask: CronTaskId;
  try {
    lockedTask = assertCronTaskLocked(cronDecision);
  } catch (err) {
    return {
      allowed: false,
      reason: "Cron task not locked; preflight validation failed",
      escalationReason: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 3: Check for escalation outcome in decision record
  // If decision record has escalation marker, block dispatch
  if ((cronDecision as unknown as Record<string, unknown>).escalation === true) {
    return {
      allowed: false,
      reason: "Cron state invalid; escalation in progress",
      escalationReason: "Escalation outcome present in decision record",
      lockedTask,
    };
  }

  // Step 4: Get task metadata and extract required capabilities
  const taskMetadata = getCronTaskMetadata(lockedTask);
  if (!taskMetadata) {
    return {
      allowed: false,
      reason: `Unable to load metadata for cron task ${lockedTask}`,
      escalationReason: "Task metadata not found in registry",
      lockedTask,
    };
  }

  const requiredCapabilities = taskMetadata.requiredCapabilities;

  // Step 5: Deny-by-default: check if requested capability is in required set
  if (!requiredCapabilities.includes(requestedCapability)) {
    // Log denial attempt
    console.warn(
      `[CronDispatchChecker] Capability denial: Cron task ${lockedTask} does not permit capability ${requestedCapability}. Required: [${requiredCapabilities.join(", ")}]`
    );
    return {
      allowed: false,
      reason: `Cron task ${lockedTask} does not permit capability ${requestedCapability}`,
      lockedTask,
    };
  }

  // Step 6: Capability is in required set → ALLOW
  return {
    allowed: true,
    lockedTask,
  };
}
