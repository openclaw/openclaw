/**
 * CoT planning tool for persisting and updating structured goal plans.
 *
 * Provides the model-facing `update_goal_plan` tool that:
 * - Attaches a new structured plan to the active goal
 * - Updates step statuses as the plan is executed
 * - Re-plans by replacing the plan snapshot when the approach changes
 */
import { Type } from "typebox";
import { getSessionEntry, patchSessionEntry } from "../../config/sessions/store.js";
import type {
  SessionGoal,
  SessionGoalPlanSnapshot,
  SessionGoalPlanStep,
} from "../../config/sessions/types.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readStringParam,
  readStringArrayParam,
} from "./common.js";

type CotPlanningToolOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
};

type CotPlanToolSessionScope = {
  sessionKey: string;
  storePath: string;
};

function resolvePlanToolSessionScope(options: CotPlanningToolOptions): CotPlanToolSessionScope {
  const sessionKey = options.runSessionKey?.trim() || options.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("session key required");
  }
  const parsedSessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const parsedAgentSessionAgentId = parseAgentSessionKey(options.agentSessionKey)?.agentId;
  const agentId = normalizeAgentId(
    parsedSessionAgentId ?? parsedAgentSessionAgentId ?? options.sessionAgentId,
  );
  return {
    sessionKey,
    storePath: resolveStorePath(options.config?.session?.store, {
      agentId,
    }),
  };
}

const STEP_STATUSES = ["pending", "active", "done", "blocked", "skipped"] as const;

export const SetPlanSchema = Type.Object({
  approach: Type.String({
    description: "1-2 sentence summary of the overall strategy.",
  }),
  steps: Type.Array(
    Type.Object({
      id: Type.String({ description: "Short step id (e.g. s1, s2)." }),
      description: Type.String({ description: "What this step does." }),
      depends_on: Type.Optional(
        Type.Array(Type.String(), { description: "Step ids that must complete first." }),
      ),
      checkpoint: Type.Optional(Type.Boolean({ description: "Verify progress after this step." })),
      estimated_tokens: Type.Optional(
        Type.Number({ description: "Rough token cost estimate." }),
      ),
    }),
    { description: "Ordered list of plan steps." },
  ),
  risks: Type.Optional(
    Type.Array(Type.String(), { description: "Known risks or failure modes." }),
  ),
  checkpoints: Type.Optional(
    Type.Array(Type.String(), { description: "Key verification points." }),
  ),
});

const UpdateStepSchema = Type.Object({
  step_id: Type.String({ description: "Id of the step to update." }),
  status: stringEnum(STEP_STATUSES, {
    description: "New status: pending, active, done, blocked, or skipped.",
  }),
  note: Type.Optional(Type.String({ description: "Optional status note." })),
});

/** Parses and validates a raw structured goal plan payload. */
export function parseGoalPlan(params: Record<string, unknown>): SessionGoalPlanSnapshot {
  const approach = readStringParam(params, "approach", { required: true });
  const rawSteps = params.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new ToolInputError("steps required");
  }

  const steps: SessionGoalPlanStep[] = rawSteps.map((raw: unknown) => {
    const step = raw as Record<string, unknown>;
    const id = readStringParam(step, "id", { required: true });
    const description = readStringParam(step, "description", { required: true });
    const dependsOn = readStringArrayParam(step, "depends_on");
    const checkpoint =
      typeof step.checkpoint === "boolean" ? step.checkpoint : undefined;
    const estimatedTokens =
      typeof step.estimated_tokens === "number" && Number.isFinite(step.estimated_tokens)
        ? Math.floor(step.estimated_tokens)
        : undefined;
    return {
      id,
      description,
      status: "pending" as const,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(estimatedTokens && estimatedTokens > 0 ? { estimatedTokens } : {}),
    };
  });

  // Validate step id uniqueness.
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new ToolInputError(`duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  // Validate dependency references.
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new ToolInputError(`step ${step.id} depends on unknown step: ${dep}`);
      }
    }
  }

  const rawRisks = readStringArrayParam(params, "risks");
  const rawCheckpoints = readStringArrayParam(params, "checkpoints");

  return {
    schemaVersion: 1,
    createdAt: Date.now(),
    approach,
    steps,
    ...(rawRisks && rawRisks.length > 0 ? { risks: rawRisks } : {}),
    ...(rawCheckpoints && rawCheckpoints.length > 0 ? { checkpoints: rawCheckpoints } : {}),
  };
}

/** Creates the tool that attaches or replaces a structured plan on the active goal. */
export function createSetGoalPlanTool(options: CotPlanningToolOptions): AnyAgentTool {
  return {
    label: "Set Goal Plan",
    name: "update_goal_plan",
    displaySummary: "Set or replace a structured goal plan",
    description:
      "Attach a structured Chain-of-Thought plan to the active goal. Replaces any existing plan. Call after producing a <cot_plan> or when re-planning.",
    parameters: SetPlanSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const plan = parseGoalPlan(params);

      const scope = resolvePlanToolSessionScope(options);
      let updatedGoal: SessionGoal | undefined;

      await patchSessionEntry({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        update: (entry) => {
          if (!entry.goal) {
            throw new ToolInputError("no active goal");
          }
          if (entry.goal.status === "complete") {
            throw new ToolInputError("goal is already complete");
          }
          const next: SessionGoal = {
            ...entry.goal,
            planSnapshot: plan,
            updatedAt: Date.now(),
          };
          updatedGoal = next;
          return { goal: next };
        },
      });

      if (!updatedGoal) {
        throw new ToolInputError("session not found");
      }

      return jsonResult({
        status: "plan_set",
        steps: plan.steps.length,
        approach: plan.approach,
      });
    },
  };
}

/** Creates the tool that updates a single step's status in the active plan. */
export function createUpdateGoalPlanStepTool(options: CotPlanningToolOptions): AnyAgentTool {
  return {
    label: "Update Plan Step",
    name: "update_goal_plan_step",
    displaySummary: "Update a plan step's status",
    description:
      "Mark a specific plan step as active, done, blocked, or skipped. Use after completing or encountering issues with a step.",
    parameters: UpdateStepSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const stepId = readStringParam(params, "step_id", { required: true });
      const status = readStringParam(params, "status", { required: true });
      if (!STEP_STATUSES.includes(status as (typeof STEP_STATUSES)[number])) {
        throw new ToolInputError(`status must be one of ${STEP_STATUSES.join(", ")}`);
      }
      const note = readStringParam(params, "note");

      const scope = resolvePlanToolSessionScope(options);
      let updatedStep: SessionGoalPlanStep | undefined;

      await patchSessionEntry({
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        update: (entry) => {
          if (!entry.goal) {
            throw new ToolInputError("no active goal");
          }
          const plan = entry.goal.planSnapshot;
          if (!plan) {
            throw new ToolInputError("no plan attached to goal");
          }
          const stepIndex = plan.steps.findIndex((s) => s.id === stepId);
          if (stepIndex === -1) {
            throw new ToolInputError(`unknown step id: ${stepId}`);
          }
          const newSteps = [...plan.steps];
          newSteps[stepIndex] = {
            ...newSteps[stepIndex],
            status: status as SessionGoalPlanStep["status"],
            ...(note ? { note } : {}),
          };
          updatedStep = newSteps[stepIndex];
          const updatedPlan: SessionGoalPlanSnapshot = { ...plan, steps: newSteps };
          return {
            goal: {
              ...entry.goal,
              planSnapshot: updatedPlan,
              updatedAt: Date.now(),
            },
          };
        },
      });

      if (!updatedStep) {
        throw new ToolInputError("session not found");
      }

      return jsonResult({
        status: "step_updated",
        step: {
          id: updatedStep.id,
          status: updatedStep.status,
          description: updatedStep.description,
          ...(updatedStep.note ? { note: updatedStep.note } : {}),
        },
      });
    },
  };
}
