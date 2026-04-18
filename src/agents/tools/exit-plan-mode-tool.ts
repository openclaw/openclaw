import { Type } from "@sinclair/typebox";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeExitPlanModeTool,
  EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

/**
 * `exit_plan_mode` agent tool — proposes the current plan for user
 * approval. The runtime emits an `agent_approval_event` with the plan
 * payload; the user can Approve (mutations unlock + agent executes),
 * Reject with feedback (agent stays in plan mode and revises), or let
 * it Time Out.
 *
 * As with `enter_plan_mode`, the tool body just returns a structured
 * result describing the requested transition; the embedded runner
 * (src/agents/pi-embedded-runner/run.ts) intercepts the tool call to
 * fire the approval event and persist the pending state.
 *
 * Schema is intentionally a near-copy of update_plan's plan shape so
 * authors don't need to learn a second format.
 */

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

const ExitPlanModeToolSchema = Type.Object({
  // PR-9 Tier 1: explicit plan title field. Without this the agent's
  // chat text above the tool call became the de-facto title (brittle —
  // sometimes the agent's narration leaked in instead of a real title).
  // Title is required-ish at the schema level but tolerated when
  // omitted (the runtime falls back to a generated default).
  title: Type.Optional(
    Type.String({
      description:
        "Concise plan name (under 80 chars). Used as the approval-card header, " +
        "the sidebar title, and (when persisted) the markdown filename slug. " +
        'Examples: "Migrate VM provisioning to golden snapshot", ' +
        '"Fix websocket reconnect race in PR-67721". ' +
        "Do NOT put plan content here — that goes in `plan` and `summary`.",
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
            description: 'Present-continuous form shown while in_progress (e.g. "Running tests").',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    {
      minItems: 1,
      description: "The plan being proposed for approval. At most one step may be in_progress.",
    },
  ),
  summary: Type.Optional(
    Type.String({
      description:
        "Optional one-line summary surfaced in the approval prompt (UI / channel renderers).",
    }),
  ),
});

type ExitPlanModeStep = {
  step: string;
  status: (typeof PLAN_STEP_STATUSES)[number];
  activeForm?: string;
};

function readPlanSteps(params: Record<string, unknown>): ExitPlanModeStep[] {
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new ToolInputError("plan required (cannot exit plan mode without a proposal)");
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

export interface CreateExitPlanModeToolOptions {
  /** Stable run identifier used by the runner to scope the approval event. */
  runId?: string;
}

export function createExitPlanModeTool(options?: CreateExitPlanModeToolOptions): AnyAgentTool {
  const runId = options?.runId;
  return {
    label: "Exit Plan Mode",
    name: "exit_plan_mode",
    displaySummary: EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
    description: describeExitPlanModeTool(),
    parameters: ExitPlanModeToolSchema,
    execute: async (_toolCallId, args, _signal) => {
      const params = args as Record<string, unknown>;
      const summary = readStringParam(params, "summary");
      // PR-9 Tier 1: explicit title field; trim + clamp to 80 chars so
      // the approval-card / sidebar header stays scannable.
      const rawTitle = readStringParam(params, "title");
      const title = rawTitle ? rawTitle.trim().slice(0, 80) : undefined;
      const plan = readPlanSteps(params);

      // PR-8 follow-up: hard-block plan submission while any subagents
      // spawned during this run are still in flight. Eva's own post-
      // mortem identified the bug: "I treated 'research launched' as
      // 'research completed,' and submitted the plan with incomplete
      // research." The runtime now enforces the rule the agent should
      // follow: wait for research children before submitting.
      //
      // Paired with a tool-description warning at the top so the agent
      // sees the requirement up-front (soft steer) as well as hitting
      // this hard block if it ignores the warning.
      if (runId) {
        const ctx = getAgentRunContext(runId);
        const open = ctx?.openSubagentRunIds;
        if (open && open.size > 0) {
          const ids = [...open].slice(0, 5).join(", ");
          const more = open.size > 5 ? ` and ${open.size - 5} more` : "";
          throw new ToolInputError(
            `Cannot submit plan: ${open.size} subagent(s) you spawned during this ` +
              `plan-mode investigation are still running (${ids}${more}). Wait for ` +
              `their completion messages to arrive, then synthesize the final plan ` +
              `from their results and call exit_plan_mode again. Treat unresolved ` +
              `children as a blocking dependency of the investigation phase — ` +
              `'research launched' is not 'research complete.'`,
          );
        }
      }
      // PR-8 follow-up: return non-empty content. Empty content arrays
      // trip third-party transcript-pairing extensions (lossless-claw)
      // which inject `[lossless-claw] missing tool result` placeholders
      // into the agent's read-time context. Non-empty content satisfies
      // the pairing check and keeps the agent's view of past turns clean.
      const stepCount = plan.length;
      // PR-9 Tier 1: prefer the explicit `title` field for the
      // confirmation text when provided; fall back to summary, then to
      // the bare step-count phrasing.
      const headlineLabel = title ?? summary;
      const text = headlineLabel
        ? `Plan submitted for approval — ${headlineLabel} (${stepCount} ${stepCount === 1 ? "step" : "steps"}).`
        : `Plan submitted for approval (${stepCount} ${stepCount === 1 ? "step" : "steps"}).`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: "approval_requested" as const,
          ...(title ? { title } : {}),
          ...(summary ? { summary } : {}),
          plan,
        },
      };
    },
  };
}
