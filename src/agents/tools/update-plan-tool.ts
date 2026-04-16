import { Type } from "@sinclair/typebox";
import {
  emitAgentPlanEvent,
  getAgentRunContext,
  type PlanStepSnapshot,
} from "../../infra/agent-events.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeUpdatePlanTool,
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

/**
 * Allowed `update_plan` step statuses. Exported so other modules
 * (`plan-hydration.ts`, hooks, channel renderers) can re-use the
 * union instead of redefining a parallel string set.
 */
export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

const UpdatePlanToolSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({
      description: "Optional short note explaining what changed in the plan.",
    }),
  ),
  merge: Type.Optional(
    Type.Boolean({
      description:
        "When true, update existing steps by matching step text and add new ones. " +
        "When false (default), replace the entire plan.",
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
              "Present-continuous form used during in_progress display. Accepted on any status but only rendered for in_progress steps.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    {
      minItems: 1,
      description: "Ordered list of plan steps. At most one step may be in_progress.",
    },
  ),
});

export type UpdatePlanStep = {
  step: string;
  status: PlanStepStatus;
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
    if (!PLAN_STEP_STATUSES.includes(status as PlanStepStatus)) {
      throw new ToolInputError(
        `plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
      );
    }
    const activeForm = readStringParam(stepParams, "activeForm");
    return {
      step,
      status: status as PlanStepStatus,
      ...(activeForm ? { activeForm } : {}),
    };
  });

  const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }

  // Reject duplicate step TEXT within a single incoming patch (Codex P2
  // on PR #67514). Merge mode keys steps by `step` text — if the patch
  // contains two entries with the same step text, the second clobbers the
  // first, and in merge mode they collide on the same map key when
  // matching against the previous plan, silently rewriting unrelated
  // history. Better to surface this at input time.
  const seenSteps = new Set<string>();
  for (let i = 0; i < steps.length; i += 1) {
    const stepText = steps[i].step;
    if (seenSteps.has(stepText)) {
      throw new ToolInputError(
        `plan[${i}].step is duplicated within the patch ("${stepText}"); ` +
          "step text must be unique because merge mode uses it as the join key",
      );
    }
    seenSteps.add(stepText);
  }
  return steps;
}

/**
 * Merges incoming plan steps into existing ones by matching `step` text.
 * - Existing steps keep their original order.
 * - Overlapping steps update their status/activeForm from incoming.
 * - Novel incoming steps are appended in the order they appear.
 * Adapted from `src/agents/plan-store.ts:204` on the
 * `phase4/cross-session-plans` branch (in-memory variant — no
 * `updatedBy`/`updatedAt` attribution, since this layer doesn't own
 * cross-session persistence).
 */
function mergeSteps(existing: UpdatePlanStep[], incoming: UpdatePlanStep[]): UpdatePlanStep[] {
  const incomingByStep = new Map<string, UpdatePlanStep>();
  for (const s of incoming) {
    if (!incomingByStep.has(s.step)) {
      incomingByStep.set(s.step, s);
    }
  }
  const existingTexts = new Set(existing.map((s) => s.step));
  const merged: UpdatePlanStep[] = existing.map((s) => {
    const update = incomingByStep.get(s.step);
    if (!update) {
      return s;
    }
    return {
      step: update.step,
      status: update.status,
      ...(update.activeForm !== undefined ? { activeForm: update.activeForm } : {}),
    };
  });
  const appended = new Set<string>();
  for (const s of incoming) {
    if (!existingTexts.has(s.step) && !appended.has(s.step)) {
      merged.push({
        step: s.step,
        status: s.status,
        ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
      });
      appended.add(s.step);
    }
  }
  return merged;
}

export interface CreateUpdatePlanToolOptions {
  /**
   * Stable run identifier. When provided, merge mode reads the previous
   * plan from `AgentRunContext.lastPlanSteps` and writes the merged
   * result back. When omitted, merge mode falls back to replace
   * (no previous plan available — useful for tests/standalone).
   */
  runId?: string;
}

export function createUpdatePlanTool(options?: CreateUpdatePlanToolOptions): AnyAgentTool {
  const runId = options?.runId;
  return {
    label: "Update Plan",
    name: "update_plan",
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    description: describeUpdatePlanTool(),
    parameters: UpdatePlanToolSchema,
    execute: async (_toolCallId, args, _signal) => {
      const params = args as Record<string, unknown>;
      const explanation = readStringParam(params, "explanation");
      const merge = typeof params.merge === "boolean" ? params.merge : false;
      const incomingSteps = readPlanSteps(params);

      const ctx = runId ? getAgentRunContext(runId) : undefined;
      const previousSteps = (ctx?.lastPlanSteps ?? []) as UpdatePlanStep[];
      const plan: UpdatePlanStep[] =
        merge && previousSteps.length > 0
          ? mergeSteps(previousSteps, incomingSteps)
          : incomingSteps;

      // Re-validate the active-step invariant on the MERGED plan
      // (Codex P1 on PR #67514): readPlanSteps only enforces the
      // single-in_progress rule on the incoming patch, but merge can
      // still produce a final plan with two in_progress entries when
      // the previous plan had one in_progress step and the patch marks
      // a different step as in_progress. The tool's own contract — and
      // downstream renderers — assume at most one active step.
      const mergedInProgress = plan.filter((s) => s.status === "in_progress").length;
      if (mergedInProgress > 1) {
        throw new ToolInputError(
          "merge would produce a plan with multiple in_progress steps; " +
            "explicitly mark the prior in_progress step as completed/cancelled in the same patch",
        );
      }

      // Persist for next merge in this run. Snapshot stored as
      // `PlanStepSnapshot[]` (structural superset of `UpdatePlanStep[]`).
      if (ctx) {
        ctx.lastPlanSteps = plan.map<PlanStepSnapshot>((s) => ({
          step: s.step,
          status: s.status,
          ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
        }));
      }

      // Emit `agent_plan_event` so channel renderers + control UI see updates.
      // Skip emit when we have no runId — that's the standalone/test path.
      if (runId) {
        emitAgentPlanEvent({
          runId,
          ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          data: {
            phase: "update",
            title: "Plan updated",
            ...(explanation ? { explanation } : {}),
            steps: plan.map((s) => s.step),
            source: "update_plan",
          },
        });
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
