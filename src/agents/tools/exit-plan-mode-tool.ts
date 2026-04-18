import { Type } from "@sinclair/typebox";
import { getAgentRunContext } from "../../infra/agent-events.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeExitPlanModeTool,
  EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";
// PR-8 review fix (Copilot #3105170294): import the canonical
// PLAN_STEP_STATUSES from update-plan-tool.ts as the single source of
// truth for valid step statuses. Prior local duplicate could drift
// (adding a status in one tool but not the other).
import { PLAN_STEP_STATUSES, type PlanStepStatus } from "./update-plan-tool.js";

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

// PR-8 review fix (Copilot #3105170294): use the imported
// PLAN_STEP_STATUSES from update-plan-tool.ts \u2014 see import above.
// Prior local duplicate is removed.

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
  // PR-10 plan-archetype fields — all optional and backwards-compatible.
  // The plan-archetype system-prompt fragment (see plan-mode/plan-archetype-prompt.ts)
  // tells the agent when these are required vs nice-to-have.
  analysis: Type.Optional(
    Type.String({
      description:
        "Markdown body explaining current state, chosen approach, and rationale. " +
        "Multi-paragraph; this is the part of the plan that gives the user enough " +
        "context to evaluate the proposal without re-reading every transcript turn. " +
        "Required for non-trivial multi-file changes; can be omitted for one-shot fixes.",
    }),
  ),
  assumptions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Explicit assumptions made during planning. Each entry is one sentence. " +
        'Examples: "Tests will pass on first run after the new path lands", ' +
        '"`packages/auth` retains its current public exports". ' +
        "If any assumption is wrong, the plan needs revision — surface them.",
    }),
  ),
  risks: Type.Optional(
    Type.Array(
      Type.Object(
        {
          risk: Type.String({ description: "What could go wrong (one sentence)." }),
          mitigation: Type.String({
            description: "How the plan reduces or contains the risk.",
          }),
        },
        { additionalProperties: false },
      ),
      {
        description:
          "Risk register: things that could go wrong + how the plan mitigates each. " +
          "Use this to surface known unknowns before approval.",
      },
    ),
  ),
  verification: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Concrete steps that will confirm the plan succeeded. " +
        'Examples: "`pnpm test src/agents/...` passes", ' +
        '"VM 127263714 responds to SSH within 60s", ' +
        '"Telegram approval card renders inline buttons for kind=plugin". ' +
        "Required for tasks where premature closure has cost; covers Wave B1 closure-gate criteria.",
    }),
  ),
  references: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional list of file paths, URLs, PR numbers, or doc references the plan builds on. " +
        'Examples: "src/agents/plan-mode/types.ts:42", "PR #67538", "docs/agents/prompt-stack-spec.md". ' +
        "Renders as a Reference section in the persisted markdown.",
    }),
  ),
});

type ExitPlanModeStep = {
  step: string;
  status: PlanStepStatus;
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
      // PR-10 archetype fields. All optional; readPlanArchetypeFields
      // does the parsing + sanitization (trim + drop blank entries).
      const archetype = readPlanArchetypeFields(params);

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
          // PR-10 archetype fields. Spread only when the agent supplied
          // them — keeps the tool result minimal for simple plans.
          ...(archetype.analysis ? { analysis: archetype.analysis } : {}),
          ...(archetype.assumptions && archetype.assumptions.length > 0
            ? { assumptions: archetype.assumptions }
            : {}),
          ...(archetype.risks && archetype.risks.length > 0 ? { risks: archetype.risks } : {}),
          ...(archetype.verification && archetype.verification.length > 0
            ? { verification: archetype.verification }
            : {}),
          ...(archetype.references && archetype.references.length > 0
            ? { references: archetype.references }
            : {}),
        },
      };
    },
  };
}

/**
 * PR-10: parse the optional archetype fields from `exit_plan_mode` args.
 * Each field is parsed defensively (trim + drop blank entries) so a
 * malformed agent payload doesn't poison the approval card. Returns an
 * object with only the parsed fields populated; missing/invalid fields
 * stay undefined (caller spreads them conditionally).
 */
function readPlanArchetypeFields(params: Record<string, unknown>): {
  analysis?: string;
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
} {
  const out: ReturnType<typeof readPlanArchetypeFields> = {};
  const rawAnalysis = readStringParam(params, "analysis");
  if (rawAnalysis && rawAnalysis.trim().length > 0) {
    out.analysis = rawAnalysis.trim();
  }
  const rawAssumptions = params.assumptions;
  if (Array.isArray(rawAssumptions)) {
    const cleaned = rawAssumptions
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cleaned.length > 0) {
      out.assumptions = cleaned;
    }
  }
  const rawRisks = params.risks;
  if (Array.isArray(rawRisks)) {
    const cleaned: Array<{ risk: string; mitigation: string }> = [];
    for (const entry of rawRisks) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const risk = typeof e.risk === "string" ? e.risk.trim() : "";
      const mitigation = typeof e.mitigation === "string" ? e.mitigation.trim() : "";
      if (risk.length > 0 && mitigation.length > 0) {
        cleaned.push({ risk, mitigation });
      }
    }
    if (cleaned.length > 0) {
      out.risks = cleaned;
    }
  }
  const rawVerification = params.verification;
  if (Array.isArray(rawVerification)) {
    const cleaned = rawVerification
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cleaned.length > 0) {
      out.verification = cleaned;
    }
  }
  const rawReferences = params.references;
  if (Array.isArray(rawReferences)) {
    const cleaned = rawReferences
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cleaned.length > 0) {
      out.references = cleaned;
    }
  }
  return out;
}
