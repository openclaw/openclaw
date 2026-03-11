/**
 * Cron Schedule Gating Wrapper for ClarityBurst
 *
 * This module provides utilities for wrapping cron scheduling calls with ClarityBurst
 * CRON_SCHEDULE execution-boundary gating. All cron schedule creation, update, enablement,
 * and persistence operations must pass through the gate before execution.
 *
 * Pattern:
 *   const job = await applyCronScheduleGateAndAdd(jobCreate);
 *   const updated = await applyCronScheduleGateAndUpdate(jobId, patch);
 *
 * The gate will:
 * 1. Extract operation type (create/update/enable) and schedule info from parameters
 * 2. Route through ClarityBurst CRON_SCHEDULE gate
 * 3. Throw ClarityBurstAbstainError if the gate abstains (CONFIRM or CLARIFY)
 * 4. Execute the cron operation if the gate approves (PROCEED)
 * 5. Log the decision with contractId, outcome, action type, and schedule context
 */

import { ClarityBurstAbstainError } from "./errors.js";
import { applyCronScheduleOverrides, type CronScheduleContext } from "./decision-override.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const gatingLog = createSubsystemLogger("clarityburst-cron-schedule-gating");

/**
 * Type guard to check if result is an abstain outcome
 */
function isAbstainOutcome(
  result: any
): result is { outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY"; reason?: string; instructions?: string; contractId?: string | null } {
  return result && (result.outcome === "ABSTAIN_CONFIRM" || result.outcome === "ABSTAIN_CLARIFY");
}

/**
 * Extract cron expression or recurrence summary from schedule object
 */
function extractScheduleSummary(schedule?: unknown): string {
  if (!schedule || typeof schedule !== "object") {
    return "unknown";
  }
  const sched = schedule as Record<string, unknown>;
  
  if (sched.kind === "cron") {
    const expr = String(sched.expr ?? "");
    const tz = String(sched.tz ?? "");
    return tz ? `${expr} @ ${tz}` : expr;
  }
  if (sched.kind === "every") {
    const ms = Number(sched.everyMs ?? 0);
    return `every ${ms}ms`;
  }
  if (sched.kind === "at") {
    return `at ${String(sched.at ?? "")}`;
  }
  return "unknown";
}

/**
 * Apply CRON_SCHEDULE gate and execute cron job creation
 *
 * This is the primary wrapper for cron.add calls that should be gated.
 * It applies the ClarityBurst CRON_SCHEDULE gate immediately before the job
 * is persisted to storage and registered with the dispatcher.
 *
 * @param jobCreate - The job creation parameters
 * @param execute - The actual cron.add function to execute if gate approves
 * @param actionType - Optional action type label for logging (default: "create")
 * @returns The created job result if gate approves, or throws on abstain
 * @throws ClarityBurstAbstainError if the gate returns ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
 *
 * @example
 * ```typescript
 * const job = await applyCronScheduleGateAndAdd(
 *   { name: "reminder", schedule: { kind: "cron", expr: "0 9 * * MON-FRI" } },
 *   async (params) => context.cron.add(params),
 *   "create"
 * );
 * ```
 */
export async function applyCronScheduleGateAndAdd<T>(
  jobCreate: any,
  execute: (params: any) => Promise<T>,
  actionType: string = "create"
): Promise<T> {
  const schedule = jobCreate?.schedule;
  const scheduleSummary = extractScheduleSummary(schedule);
  const jobName = String(jobCreate?.name ?? jobCreate?.id ?? "unknown");

  // Create context for the CRON_SCHEDULE gate
  const context: CronScheduleContext = {
    stageId: "CRON_SCHEDULE",
    userConfirmed: false,
    schedule: scheduleSummary,
    taskType: "cron_create",
    target: jobName,
  };

  // Apply the CRON_SCHEDULE gate
  const gateResult = await applyCronScheduleOverrides(context);

  // Log the gating decision
  gatingLog.debug("CRON_SCHEDULE gate decision", {
    ontology: "CRON_SCHEDULE",
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    actionType,
    jobName,
    scheduleSummary,
  });

  // If gate abstains, throw the appropriate error
  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "CRON_SCHEDULE",
      outcome: gateResult.outcome as "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY",
      reason: gateResult.reason as any,
      contractId: gateResult.contractId,
      instructions:
        gateResult.instructions ??
        `Cron schedule creation for job "${jobName}" (schedule: ${scheduleSummary}) blocked by ClarityBurst CRON_SCHEDULE gate.`,
    });
    gatingLog.warn("CRON_SCHEDULE gate blocked creation", {
      ontology: "CRON_SCHEDULE",
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      jobName,
      scheduleSummary,
    });
    throw error;
  }

  // Gate approved: execute the cron operation
  gatingLog.debug("CRON_SCHEDULE gate approved creation", {
    ontology: "CRON_SCHEDULE",
    contractId: gateResult.contractId,
    jobName,
    scheduleSummary,
  });

  return execute(jobCreate);
}

/**
 * Apply CRON_SCHEDULE gate and execute cron job update
 *
 * This wrapper applies the ClarityBurst gate before updating an existing job.
 * It checks for schedule changes, enablement, and persistence side effects.
 *
 * @param jobId - The job ID to update
 * @param patch - The patch object with updates
 * @param execute - The actual cron.update function to execute if gate approves
 * @param actionType - Optional action type label for logging (default: "update")
 * @returns The updated job result if gate approves, or throws on abstain
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * const updated = await applyCronScheduleGateAndUpdate(
 *   "job-123",
 *   { schedule: { kind: "cron", expr: "0 10 * * *" } },
 *   async (id, p) => context.cron.update(id, p),
 *   "update"
 * );
 * ```
 */
export async function applyCronScheduleGateAndUpdate<T>(
  jobId: string,
  patch: any,
  execute: (id: string, p: any) => Promise<T>,
  actionType: string = "update"
): Promise<T> {
  const schedule = patch?.schedule;
  const scheduleSummary = extractScheduleSummary(schedule);
  const isEnablement = patch?.enabled !== undefined;

  // Determine task type based on patch content
  let taskType = "cron_update";
  if (isEnablement && patch?.enabled === true) {
    taskType = "cron_enable";
  } else if (isEnablement && patch?.enabled === false) {
    taskType = "cron_disable";
  }

  // Create context for the CRON_SCHEDULE gate
  const context: CronScheduleContext = {
    stageId: "CRON_SCHEDULE",
    userConfirmed: false,
    schedule: scheduleSummary || undefined,
    taskType,
    target: jobId,
  };

  // Apply the CRON_SCHEDULE gate
  const gateResult = await applyCronScheduleOverrides(context);

  // Log the gating decision
  gatingLog.debug("CRON_SCHEDULE gate decision", {
    ontology: "CRON_SCHEDULE",
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    actionType,
    jobId,
    taskType,
    scheduleSummary,
    isEnablement,
  });

  // If gate abstains, throw the appropriate error
  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "CRON_SCHEDULE",
      outcome: gateResult.outcome as "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY",
      reason: gateResult.reason as any,
      contractId: gateResult.contractId,
      instructions:
        gateResult.instructions ??
        `Cron schedule update for job "${jobId}" (${taskType}${scheduleSummary ? `: ${scheduleSummary}` : ""}) blocked by ClarityBurst CRON_SCHEDULE gate.`,
    });
    gatingLog.warn("CRON_SCHEDULE gate blocked update", {
      ontology: "CRON_SCHEDULE",
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      jobId,
      taskType,
      scheduleSummary,
    });
    throw error;
  }

  // Gate approved: execute the update
  gatingLog.debug("CRON_SCHEDULE gate approved update", {
    ontology: "CRON_SCHEDULE",
    contractId: gateResult.contractId,
    jobId,
    taskType,
    scheduleSummary,
  });

  return execute(jobId, patch);
}

/**
 * Apply CRON_SCHEDULE gate and execute cron job enablement
 *
 * This is a convenience wrapper for enabling/disabling a cron job.
 * Delegates to applyCronScheduleGateAndUpdate with appropriate context.
 *
 * @param jobId - The job ID to enable or disable
 * @param enabled - Whether to enable (true) or disable (false)
 * @param execute - The actual cron.update function to execute if gate approves
 * @returns The updated job result if gate approves, or throws on abstain
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * const job = await applyCronScheduleGateAndSetEnabled(
 *   "job-123",
 *   true,
 *   async (id, p) => context.cron.update(id, p)
 * );
 * ```
 */
export async function applyCronScheduleGateAndSetEnabled<T>(
  jobId: string,
  enabled: boolean,
  execute: (id: string, p: any) => Promise<T>
): Promise<T> {
  const actionType = enabled ? "enable" : "disable";
  return applyCronScheduleGateAndUpdate(
    jobId,
    { enabled },
    execute,
    actionType
  );
}
