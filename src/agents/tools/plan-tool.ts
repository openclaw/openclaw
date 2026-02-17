/**
 * Plan tool — allows agents to create, review, and execute plans.
 * Agents navigate between plan mode and execution mode.
 */

import { z } from "zod";
import {
  createPlan,
  getPlan,
  submitPlanForReview,
  reviewPlan,
  startPlanExecution,
  updateStepStatus,
  getNextExecutablePhase,
  listPlans,
} from "../plan-mode.js";
import { zodToToolJsonSchema } from "../schema/zod-tool-schema.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const PlanToolZodSchema = z.object({
  action: z.enum([
    "create",
    "get",
    "submit_for_review",
    "review",
    "start_execution",
    "update_step",
    "next_phase",
    "list",
  ]),
  planId: z.string().optional(),
  sessionKey: z.string().optional(),
  task: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        agentId: z.string().optional(),
        dependencies: z.array(z.string()),
        estimatedComplexity: z.enum(["trivial", "moderate", "complex"]),
      }),
    )
    .optional(),
  reviewerAgentId: z.string().optional(),
  decision: z.enum(["approve", "reject"]).optional(),
  notes: z.string().optional(),
  stepId: z.string().optional(),
  stepStatus: z.enum(["pending", "running", "completed", "failed", "skipped"]).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

const PlanToolSchema = zodToToolJsonSchema(PlanToolZodSchema);

export function createPlanTool(): AnyAgentTool {
  return {
    label: "Plan",
    name: "plan",
    description: `Manage execution plans. Agents should create a plan before complex tasks. Actions:
- create: Create a new execution plan with steps and dependencies
- get: Get plan details
- submit_for_review: Submit plan for review before execution
- review: Approve or reject a plan (orchestrator/lead only)
- start_execution: Begin executing an approved plan
- update_step: Update step status during execution
- next_phase: Get next batch of steps ready for parallel execution
- list: List plans for current session`,
    parameters: PlanToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const input = PlanToolZodSchema.parse(params);

      switch (input.action) {
        case "create": {
          if (!input.sessionKey || !input.task || !input.steps) {
            return jsonResult({ ok: false, error: "sessionKey, task, and steps required" });
          }
          const plan = createPlan({
            sessionKey: input.sessionKey,
            task: input.task,
            steps: input.steps.map((s) => ({
              ...s,
              dependencies: s.dependencies ?? [],
              estimatedComplexity: s.estimatedComplexity ?? "moderate",
            })),
          });
          return jsonResult({ ok: true, plan });
        }

        case "get": {
          if (!input.planId) {
            return jsonResult({ ok: false, error: "planId required" });
          }
          const plan = getPlan(input.planId);
          return jsonResult(plan ? { ok: true, plan } : { ok: false, error: "Plan not found" });
        }

        case "submit_for_review": {
          if (!input.planId) {
            return jsonResult({ ok: false, error: "planId required" });
          }
          const plan = submitPlanForReview(input.planId, input.reviewerAgentId);
          return jsonResult(plan ? { ok: true, plan } : { ok: false, error: "Plan not found" });
        }

        case "review": {
          if (!input.planId || !input.decision) {
            return jsonResult({ ok: false, error: "planId and decision required" });
          }
          const plan = reviewPlan(input.planId, input.decision, input.notes);
          return jsonResult(
            plan
              ? { ok: true, plan }
              : { ok: false, error: "Plan not found or not pending review" },
          );
        }

        case "start_execution": {
          if (!input.planId) {
            return jsonResult({ ok: false, error: "planId required" });
          }
          const plan = startPlanExecution(input.planId);
          return jsonResult(
            plan ? { ok: true, plan } : { ok: false, error: "Plan not found or not approved" },
          );
        }

        case "update_step": {
          if (!input.planId || !input.stepId || !input.stepStatus) {
            return jsonResult({ ok: false, error: "planId, stepId, and stepStatus required" });
          }
          const plan = updateStepStatus(
            input.planId,
            input.stepId,
            input.stepStatus,
            input.result,
            input.error,
          );
          return jsonResult(
            plan ? { ok: true, plan } : { ok: false, error: "Plan or step not found" },
          );
        }

        case "next_phase": {
          if (!input.planId) {
            return jsonResult({ ok: false, error: "planId required" });
          }
          const phase = getNextExecutablePhase(input.planId);
          return jsonResult({ ok: true, phase: phase ?? [], hasMore: phase !== null });
        }

        case "list": {
          const plans = listPlans(input.sessionKey);
          return jsonResult({ ok: true, plans });
        }

        default: {
          const _exhaustiveCheck: never = input.action;
          return jsonResult({ ok: false, error: "Unknown action" });
        }
      }
    },
  };
}
