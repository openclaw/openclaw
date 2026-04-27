import { Type } from "typebox";
import { recordSessionRecoveryCheckpoint } from "../session-recovery-state.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeUpdatePlanTool,
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;

const UpdatePlanToolSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({
      description: "Optional short note explaining what changed in the plan.",
    }),
  ),
  plan: Type.Array(
    Type.Object(
      {
        step: Type.String({ description: "Short plan step." }),
        status: stringEnum(PLAN_STEP_STATUSES, {
          description: 'One of "pending", "in_progress", or "completed".',
        }),
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
    return {
      step,
      status: status as (typeof PLAN_STEP_STATUSES)[number],
    };
  });

  const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }
  return steps;
}

export function createUpdatePlanTool(opts?: {
  recovery?: {
    enabled?: boolean;
    taskId?: string;
    actorId?: string;
    sessionId?: string;
    workspaceId?: string;
    repoId?: string;
  };
}): AnyAgentTool {
  return {
    label: "Update Plan",
    name: "update_plan",
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    description: describeUpdatePlanTool(),
    parameters: UpdatePlanToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const explanation = readStringParam(params, "explanation");
      const plan = readPlanSteps(params);
      let recoveryStatus: "recorded" | "skipped" | "error" | undefined;
      if (opts?.recovery?.enabled) {
        const activeStep = plan.find((entry) => entry.status === "in_progress");
        const completedCount = plan.filter((entry) => entry.status === "completed").length;
        const summary =
          explanation ||
          (activeStep
            ? `Plan updated; current step: ${activeStep.step}`
            : `Plan updated; ${completedCount}/${plan.length} steps completed`);
        try {
          const checkpoint = recordSessionRecoveryCheckpoint({
            taskId: opts.recovery.taskId ?? `session:${opts.recovery.sessionId ?? "unknown"}`,
            actorId: opts.recovery.actorId ?? "agent",
            eventType: "plan_updated",
            summary,
            sessionId: opts.recovery.sessionId,
            workspaceId: opts.recovery.workspaceId,
            repoId: opts.recovery.repoId,
            confirmedItems: plan.map((entry) => `${entry.status}: ${entry.step}`),
            nextResumeAction: activeStep
              ? `Continue with plan step: ${activeStep.step}`
              : "Confirm whether there is a next step before continuing.",
          });
          recoveryStatus = checkpoint.status;
        } catch {
          recoveryStatus = "error";
        }
      }
      return {
        content: [],
        details: {
          status: "updated" as const,
          ...(explanation ? { explanation } : {}),
          plan,
          ...(recoveryStatus ? { recovery: recoveryStatus } : {}),
        },
      };
    },
  };
}
