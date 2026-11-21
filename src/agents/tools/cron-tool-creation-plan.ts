import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { automationJobResultId } from "../../chat/automation-job-result.js";
import { hasPluginCommandScheduleCreation } from "../../cron/plugin-command-creation.js";
import type { CronStreamExecApprovalReceipt } from "../../cron/stream-exec-authority.js";
import {
  automationSlotAtPosition,
  readAutomationCreationEvent,
  type AutomationCreationPlan,
  type AutomationCreationResult,
} from "../../shared/automation-creation.js";
import { isRecord } from "../../utils.js";
import { withToolEffectBoundary } from "../tool-effect-receipt.js";
import { CRON_CREATION_PLAN_MAX_SLOTS, CronCreationSlotsSchema } from "./cron-tool-schema.js";
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
    declare(explicitSlots: unknown, names?: unknown) {
      let slots = explicitSlots;
      if (names !== undefined) {
        if (
          slots !== undefined ||
          !Array.isArray(names) ||
          names.length > CRON_CREATION_PLAN_MAX_SLOTS
        ) {
          throw new Error("Plan with one ordered names list, up to 24 automations.");
        }
        slots = names.map((name, index) => ({ slotId: String(index + 1), name }));
      }
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
          "This turn already declared its complete automation plan. Use the original positions; omit position for a single job.",
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
    bindAdd(params: Record<string, unknown>) {
      let { planId, slotId } = params;
      if (planId === undefined && slotId === undefined) {
        if (!onePlanPerTurn || hasPluginCommandScheduleCreation()) {
          return undefined;
        }
        if (!declared) {
          const name = isRecord(params.job) ? params.job.name : params.name;
          const example = JSON.stringify({
            action: "plan",
            names: [typeof name === "string" ? name.slice(0, 200) : "Automation name"],
          });
          throw new Error(
            "No jobs saved yet. Your next tool call is automations(" +
              example +
              "). Include ALL requested names in order if creating more than one. Then repeat the add (for several, include position: 1, 2, …). Do this yourself; the user does not need to supply identifiers or confirm the plan.",
          );
        }
        planId = declared.planId;
        slotId = automationSlotAtPosition(declared, params.position)?.slotId;
        if (!slotId) {
          throw new Error(
            "Set position to the job's one-based position in your ordered names list.",
          );
        }
      }
      const slots = typeof planId === "string" ? pending.get(planId) : undefined;
      if (typeof planId !== "string" || typeof slotId !== "string" || !slots?.delete(slotId)) {
        throw new Error(
          "Use an unused position from your original declaration, or its matching planId and slotId for an explicit binding. Do not ask the user for IDs.",
        );
      }
      return {
        // An evicted plan is never restored; release only the original reservation.
        release: () => slots.add(slotId),
        result: (result: unknown): AutomationCreationResult => {
          const jobId = automationJobResultId(result);
          return {
            type: "automation_creation_result",
            planId,
            slotId,
            ...(jobId ? { status: "created", jobId } : { status: "failed" }),
          };
        },
      };
    },
  };
}

/** Keep the reservation through uncertain dispatch, but allow correction before a possible effect. */
export async function executePlannedCronMutation<T>(
  execute: (start: () => void) => Promise<T>,
  releaseReservation?: () => void,
): Promise<T> {
  return await withToolEffectBoundary(async (start) => {
    let release = releaseReservation;
    try {
      return await execute(() => {
        // Approval or scheduler dispatch may have escaped. Never reopen on a lost response.
        release = undefined;
        start();
      });
    } catch (error) {
      release?.();
      throw error;
    }
  });
}
