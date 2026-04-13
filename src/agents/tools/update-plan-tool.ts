import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { upsertSessionDraftPlanRecord } from "../../plans/plan-registry.js";
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

function derivePlanTitle(steps: UpdatePlanStep[], explanation?: string): string {
  return (
    steps.find((entry) => entry.status === "in_progress")?.step.trim() ||
    steps.find((entry) => entry.status === "pending")?.step.trim() ||
    explanation?.trim() ||
    steps[0]?.step.trim() ||
    "Execution plan"
  );
}

function formatPlanStepStatus(status: UpdatePlanStep["status"]): " " | "x" | ">" {
  if (status === "completed") {
    return "x";
  }
  if (status === "in_progress") {
    return ">";
  }
  return " ";
}

function buildPlanContent(steps: UpdatePlanStep[], explanation?: string): string {
  const lines = steps.map((entry) => `- [${formatPlanStepStatus(entry.status)}] ${entry.step}`);
  if (!explanation?.trim()) {
    return lines.join("\n");
  }
  return `${explanation.trim()}\n\n${lines.join("\n")}`;
}

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

type GatewayCaller = typeof callGateway;

export function createUpdatePlanTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Update Plan",
    name: "update_plan",
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    description: describeUpdatePlanTool(),
    searchHint: "Keep the current multi-step execution plan updated while work continues.",
    searchTags: ["plan", "planning", "steps", "status"],
    parameters: UpdatePlanToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const explanation = readStringParam(params, "explanation");
      const plan = readPlanSteps(params);
      const sessionKey = opts?.agentSessionKey?.trim();
      if (sessionKey) {
        const gatewayCall = opts?.callGateway ?? callGateway;
        const updatedAt = Date.now();
        await gatewayCall({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            planMode: "active",
            planArtifact: {
              status: "active",
              updatedAt,
              ...(explanation ? { lastExplanation: explanation } : {}),
              steps: plan,
            },
          },
          config: opts?.config,
        });
        upsertSessionDraftPlanRecord({
          sessionKey,
          title: derivePlanTitle(plan, explanation),
          summary: explanation,
          content: buildPlanContent(plan, explanation),
          updatedAt,
        });
      }
      return {
        content: [],
        details: {
          status: "updated" as const,
          ...(sessionKey ? { persisted: true } : {}),
          ...(explanation ? { explanation } : {}),
          plan,
        },
      };
    },
  };
}
