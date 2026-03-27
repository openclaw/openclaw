import { Type } from "@sinclair/typebox";
import {
  completePlan,
  createPlan,
  formatPlan,
  getPlan,
  updateStep,
  type PlanStepStatus,
} from "../plan-store.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schema — single tool with action parameter (keeps agent tool list short)
// ---------------------------------------------------------------------------

const PLAN_ACTIONS = ["set", "step", "done"] as const;
const STEP_STATUSES = ["done", "blocked", "skipped"] as const;

const PlanToolSchema = Type.Object({
  action: stringEnum(PLAN_ACTIONS, {
    description: "set = register a plan, step = update a step's status, done = mark plan complete",
  }),
  // For action=set
  goal: Type.Optional(
    Type.String({ description: "What you need to accomplish (required for action=set)" }),
  ),
  steps: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: "Ordered list of steps to complete (required for action=set)",
    }),
  ),
  done_when: Type.Optional(
    Type.String({ description: "Success criteria — how you know the task is complete" }),
  ),
  // For action=step
  step: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Step number to update (1-based, required for action=step)",
    }),
  ),
  status: Type.Optional(
    stringEnum(STEP_STATUSES, {
      description: "New status for the step (required for action=step)",
    }),
  ),
  result: Type.Optional(
    Type.String({ description: "Brief result or note for the step (optional)" }),
  ),
  // For action=done
  summary: Type.Optional(
    Type.String({ description: "Final summary of what was accomplished (optional)" }),
  ),
});

// ---------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------

interface PlanToolOpts {
  agentSessionKey?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlanTool(opts?: PlanToolOpts): AnyAgentTool {
  return {
    label: "Plan",
    name: "plan",
    description:
      "Register a task plan, track step progress, and mark completion. " +
      "Call with action=set before starting work, action=step as you progress, action=done when finished.",
    parameters: PlanToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const sessionKey = opts?.agentSessionKey ?? "unknown";

      switch (action) {
        case "set":
          return handleSet(sessionKey, params);
        case "step":
          return handleStep(sessionKey, params);
        case "done":
          return handleDone(sessionKey, params);
        default:
          return jsonResult({ error: `Unknown action: ${action}. Use set, step, or done.` });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleSet(sessionKey: string, params: Record<string, unknown>) {
  const goal = readStringParam(params, "goal");
  const doneWhen = readStringParam(params, "done_when");
  const rawSteps = params.steps;

  if (!goal) {
    return jsonResult({ error: "goal is required for action=set" });
  }
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return jsonResult({ error: "steps is required for action=set (array of strings)" });
  }

  const steps = rawSteps
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);

  if (steps.length === 0) {
    return jsonResult({ error: "steps must contain at least one non-empty string" });
  }

  const plan = createPlan(sessionKey, goal, steps, doneWhen ?? "All steps complete");

  return jsonResult({
    status: "plan_created",
    planId: plan.planId,
    stepCount: plan.steps.length,
    checklist: formatPlan(plan),
  });
}

function handleStep(sessionKey: string, params: Record<string, unknown>) {
  const plan = getPlan(sessionKey);
  if (!plan) {
    return jsonResult({
      error: "No active plan. Call plan(action=set, ...) first.",
    });
  }

  const stepNum = typeof params.step === "number" ? Math.floor(params.step) : undefined;
  const status = readStringParam(params, "status") as PlanStepStatus | undefined;
  const result = readStringParam(params, "result");

  if (!stepNum || stepNum < 1 || stepNum > plan.steps.length) {
    return jsonResult({
      error: `step must be between 1 and ${plan.steps.length}`,
    });
  }
  if (!status) {
    return jsonResult({ error: "status is required for action=step (done, blocked, skipped)" });
  }

  const updated = updateStep(sessionKey, stepNum, status, result);
  if (!updated) {
    return jsonResult({ error: "Failed to update step" });
  }

  const doneCount = updated.steps.filter((s) => s.status === "done").length;

  return jsonResult({
    status: "step_updated",
    step: stepNum,
    stepStatus: status,
    progress: `${doneCount}/${updated.steps.length}`,
    checklist: formatPlan(updated),
  });
}

function handleDone(sessionKey: string, params: Record<string, unknown>) {
  const plan = getPlan(sessionKey);
  if (!plan) {
    return jsonResult({
      error: "No active plan. Call plan(action=set, ...) first.",
    });
  }

  const summary = readStringParam(params, "summary");
  const completed = completePlan(sessionKey, summary);
  if (!completed) {
    return jsonResult({ error: "Failed to complete plan" });
  }

  const doneCount = completed.steps.filter((s) => s.status === "done").length;

  return jsonResult({
    status: "plan_complete",
    planId: completed.planId,
    stepsCompleted: doneCount,
    totalSteps: completed.steps.length,
    checklist: formatPlan(completed),
  });
}
