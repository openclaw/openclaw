import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { automationJobResultId } from "../../chat/automation-job-result.js";
import { hasPluginCommandScheduleCreation } from "../../cron/plugin-command-creation.js";
import type { CronStreamExecApprovalReceipt } from "../../cron/stream-exec-authority.js";
import {
  readAutomationCreationEvent,
  type AutomationCreationPlan,
  type AutomationCreationResult,
} from "../../shared/automation-creation.js";
import { isRecord } from "../../utils.js";
import { CronCreationSlotsSchema } from "./cron-tool-schema.js";
import { jsonResult } from "./tool-results.js";

/** Preserve the ordinary RPC response; only the native add receipt can identify a new job. */
export function cronMutationResult(
  result: unknown,
  creationReceipt?: (result: unknown) => AutomationCreationResult,
  streamExecutionApproval?: CronStreamExecApprovalReceipt,
) {
  if (!isRecord(result)) {
    if (creationReceipt) {
      throw new Error("The scheduler did not return a saved job.");
    }
    return jsonResult(result);
  }
  if (!creationReceipt && !streamExecutionApproval) {
    return jsonResult(result);
  }
  return jsonResult({
    ...result,
    ...(creationReceipt ? { automationCreation: creationReceipt(result) } : {}),
    ...(streamExecutionApproval
      ? {
          streamExecutionApproval: {
            ...streamExecutionApproval,
            message:
              "A human operator approved this watcher and its automatic restarts. The approver's identity is not supplied.",
          },
        }
      : {}),
  });
}

/** Per tool surface, shared by direct calls and its Code Mode binding; never process-wide. */
export function createCronCreationPlans(onePlanPerTurn = false) {
  let declared: AutomationCreationPlan | undefined;
  const pending = new Map<string, Set<string>>();
  return {
    declare(slots: unknown) {
      const plan = Value.Check(CronCreationSlotsSchema, slots)
        ? readAutomationCreationEvent({
            type: "automation_creation_plan",
            planId: randomUUID(),
            slots,
          })
        : undefined;
      if (plan?.type !== "automation_creation_plan") {
        throw new Error("Plan requires 1–24 named slots with distinct slot IDs.");
      }
      // The full declaration must survive the session's 8 KiB structured-details cap.
      if (Buffer.byteLength(JSON.stringify(plan)) > 7_680) {
        throw new Error("Shorten the slot IDs or names, or split this plan.");
      }
      if (onePlanPerTurn && declared) {
        if (
          declared.slots.length === plan.slots.length &&
          declared.slots.every(
            (slot, i) => slot.slotId === plan.slots[i]?.slotId && slot.name === plan.slots[i]?.name,
          )
        ) {
          return declared;
        }
        throw new Error(
          "This turn already declared its complete automation plan. Use its original planId and slots.",
        );
      }
      if (onePlanPerTurn) {
        declared = plan;
      }
      // An abandoned plan must not accumulate indefinitely on long-lived MCP tool surfaces.
      if (pending.size >= 64) {
        const oldest = pending.keys().next();
        if (!oldest.done) {
          pending.delete(oldest.value);
        }
      }
      pending.set(plan.planId, new Set(plan.slots.map((slot) => slot.slotId)));
      return plan;
    },
    bindAdd({ planId, slotId }: Record<string, unknown>) {
      // Existing SDK and tool callers can still add a job without declaring a display plan.
      if (planId === undefined && slotId === undefined) {
        if (onePlanPerTurn && !hasPluginCommandScheduleCreation()) {
          throw new Error(
            'Before adding any jobs, call automations with action:"plan" and the full ordered slots [{slotId,name}]. Then use the returned planId and the matching slotId for each add. No job was created.',
          );
        }
        return undefined;
      }
      const slots = typeof planId === "string" ? pending.get(planId) : undefined;
      if (typeof planId !== "string" || typeof slotId !== "string" || !slots?.delete(slotId)) {
        throw new Error("Use an unused slotId and its planId from this tool's plan response.");
      }
      if (!slots.size) {
        pending.delete(planId);
      }
      return (result: unknown): AutomationCreationResult => {
        const jobId = automationJobResultId(result);
        return {
          type: "automation_creation_result",
          planId,
          slotId,
          ...(jobId ? { status: "created", jobId } : { status: "failed" }),
        };
      };
    },
  };
}
