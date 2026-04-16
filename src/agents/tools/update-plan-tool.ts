import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import {
  describeUpdatePlanTool,
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

const UpdatePlanToolSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({
      description: "Optional short note explaining what changed in the plan.",
    }),
  ),
  merge: Type.Optional(
    Type.Boolean({
      description:
        'When true, update existing steps by matching step text and add new ones. ' +
        'When false (default), replace the entire plan.',
    }),
  ),
  plan: Type.Array(
    Type.Object(
      {
        step: Type.String({ description: "Short plan step." }),
        status: stringEnum(PLAN_STEP_STATUSES, {
          description: 'One of "pending", "in_progress", "completed", or "cancelled".',
        }),
        activeForm: Type.Optional(
          Type.String({
            description:
              'Present-continuous form shown while in_progress (e.g. "Running tests"). ' +
              'Omit for pending/completed/cancelled steps.',
          }),
        ),
      },
      { additionalProperties: true },
    ),
    {
      minItems: 1,
      description: "Ordered list of plan steps. At most one step may be in_progress.",
    },
  ),
});

type UpdatePlanStep = {
  step: string;
  status: (typeof PLAN_STEP_STATUSES)[number];
  activeForm?: string;
};

function readPlanSteps(params: Record<string, unknown>): UpdatePlanStep[] {
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new ToolInputError("plan required");
  }

  const steps = rawPlan.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ToolInputError(`plan[${index}] must be an object`);
    }
    const stepParams = entry as Record<string, unknown>;
    const step = readStringParam(stepParams, "step", {
      required: true,
      label: `plan[${index}].step`,
    });
    const status = readStringParam(stepParams, "status", {
      required: true,
      label: `plan[${index}].status`,
    });
    if (!PLAN_STEP_STATUSES.includes(status as (typeof PLAN_STEP_STATUSES)[number])) {
      throw new ToolInputError(
        `plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
      );
    }
    const activeForm = readStringParam(stepParams, "activeForm");
    return {
      step,
      status: status as (typeof PLAN_STEP_STATUSES)[number],
      ...(activeForm ? { activeForm } : {}),
    };
  });

  const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }
  return steps;
}

export function createUpdatePlanTool(): AnyAgentTool {
  return {
    label: "Update Plan",
    name: "update_plan",
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    description: describeUpdatePlanTool(),
    parameters: UpdatePlanToolSchema,
    execute: async (_toolCallId, args, context) => {
      const params = args as Record<string, unknown>;
      const explanation = readStringParam(params, "explanation");
      const merge = typeof params.merge === "boolean" ? params.merge : false;
      const incomingSteps = readPlanSteps(params);

      // Merge mode: requires a plan store lookup to get the previous plan.
      // Until the plan store (#67542) is wired, merge falls back to replace.
      // Replace mode (default): use incoming steps as the entire plan.
      let plan: UpdatePlanStep[];
      if (merge) {
        // TODO(#67542): look up previous plan via PlanStore.read() once wired.
        // For now, merge without a previous plan is equivalent to replace.
        plan = incomingSteps;
      } else {
        plan = incomingSteps;
      }

      return {
        content: [],
        details: {
          status: "updated" as const,
          ...(explanation ? { explanation } : {}),
          plan,
        },
      };
    },
  };
}
