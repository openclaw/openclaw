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
import {
  type AnyAgentTool,
  ToolInputError,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

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
              "Accepted on any status but only rendered for in_progress steps.",
          }),
        ),
        // PR-9 Wave B1 — closure gate fields. Optional; backwards-compatible.
        acceptanceCriteria: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional list of concrete acceptance criteria the agent will explicitly verify " +
              "before this step can be marked completed. Examples: 'tests pass', " +
              "'cortex_owner is set on the live VM', 'PR review is approved'. " +
              "When present, the runtime rejects status='completed' until verifiedCriteria " +
              "covers every entry. Use this for steps where premature closure has high cost.",
          }),
        ),
        verifiedCriteria: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Strings from acceptanceCriteria the agent has explicitly checked against live state " +
              "(e.g., after running a verification command). Update incrementally via merge mode " +
              "as each criterion is confirmed. Must be a subset of acceptanceCriteria.",
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
  acceptanceCriteria?: string[];
  verifiedCriteria?: string[];
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
    // PR-9 Wave B1 — parse + validate optional closure-gate fields.
    const acceptanceCriteria = readStringArrayParam(stepParams, "acceptanceCriteria", {
      label: `plan[${index}].acceptanceCriteria`,
    });
    const verifiedCriteria = readStringArrayParam(stepParams, "verifiedCriteria", {
      label: `plan[${index}].verifiedCriteria`,
    });
    if (verifiedCriteria && acceptanceCriteria) {
      // verifiedCriteria must be a subset of acceptanceCriteria. This
      // catches the agent verifying a criterion that no longer exists
      // after a plan revision (typo, drift) — surface it loudly so the
      // step doesn't get a phantom checkmark.
      //
      // Adversarial review #3: compare on TRIMMED text to tolerate
      // trailing/leading whitespace differences between the agent's
      // declared acceptance text and its later verified text. Strict
      // string equality is fragile: "Foo" vs "Foo " is the same
      // intent to a human and shouldn't trip the gate.
      const criteriaSet = new Set(acceptanceCriteria.map((c) => c.trim()));
      for (const v of verifiedCriteria) {
        if (!criteriaSet.has(v.trim())) {
          throw new ToolInputError(
            `plan[${index}].verifiedCriteria entry "${v}" is not in acceptanceCriteria — ` +
              "verified criteria must match an acceptance criterion (whitespace-trimmed equality)",
          );
        }
      }
    }
    if (verifiedCriteria && !acceptanceCriteria) {
      throw new ToolInputError(
        `plan[${index}].verifiedCriteria requires plan[${index}].acceptanceCriteria to be set`,
      );
    }
    // Closure gate: refuse status:"completed" when criteria are present
    // but unverified. This is the heart of B1 — it turns "done" from a
    // vibe into a contract.
    //
    // Empty `acceptanceCriteria: []` is treated as "no criteria, no
    // gate" (intentional — lets the agent declare a step as
    // gate-eligible later via merge mode without forcing one upfront).
    // Adversarial review #6: documented here explicitly so the
    // empty-array semantics are intentional, not accidental.
    if (
      status === "completed" &&
      acceptanceCriteria &&
      acceptanceCriteria.length > 0 &&
      (!verifiedCriteria || verifiedCriteria.length < acceptanceCriteria.length)
    ) {
      // Use trimmed comparison to mirror the subset-check tolerance above.
      const verifiedSet = new Set((verifiedCriteria ?? []).map((c) => c.trim()));
      const missing = acceptanceCriteria.filter((c) => !verifiedSet.has(c.trim()));
      throw new ToolInputError(
        `plan[${index}].status cannot be "completed" — ${missing.length} acceptance ` +
          `criteria not yet verified: ${missing.map((m) => `"${m}"`).join(", ")}. ` +
          "Verify them against live state, then set verifiedCriteria to include each one " +
          "before marking the step completed.",
      );
    }
    // oxc no-map-spread: build the step record with conditional
    // assignment instead of conditional spread to avoid per-iteration
    // object allocations from `...(cond ? { … } : {})`.
    const stepRecord: {
      step: string;
      status: PlanStepStatus;
      activeForm?: string;
      acceptanceCriteria?: string[];
      verifiedCriteria?: string[];
    } = { step, status: status as PlanStepStatus };
    if (activeForm) {
      stepRecord.activeForm = activeForm;
    }
    if (acceptanceCriteria) {
      stepRecord.acceptanceCriteria = acceptanceCriteria;
    }
    if (verifiedCriteria) {
      stepRecord.verifiedCriteria = verifiedCriteria;
    }
    return stepRecord;
  });

  const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }
  return steps;
}

/**
 * Reject duplicate step TEXT within a single incoming patch when merge
 * mode is requested (Copilot #3105169618 / Codex P2 on PR #67514).
 * Merge mode keys steps by `step` text — if the patch contains two
 * entries with the same step text, the second clobbers the first, and
 * they collide on the same map key when matching against the previous
 * plan, silently rewriting unrelated history. Replace mode does not
 * use step text as a join key, so legitimate plans with repeated step
 * text (e.g. "Run tests" twice in a CI workflow) are allowed there.
 */
function rejectDuplicateStepTextForMerge(steps: UpdatePlanStep[]): void {
  const seenSteps = new Set<string>();
  for (let i = 0; i < steps.length; i += 1) {
    const stepText = steps[i].step;
    if (seenSteps.has(stepText)) {
      throw new ToolInputError(
        `plan[${i}].step ("${stepText}") is duplicated within this update_plan ` +
          "call. Step text must be unique in merge mode because it is the join key. " +
          "Either rename the duplicate, or omit `merge: true` if you intentionally " +
          "want repeated step text.",
      );
    }
    seenSteps.add(stepText);
  }
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
    // PR-9 Wave B1 + PR-B review fix (Copilot #3096520563 / #3105169615):
    // preserve fields when the incoming patch omits them. This makes
    // merge mode token-efficient — a patch that only intends to change
    // `status` does NOT need to re-include `activeForm` or the
    // closure-gate fields just to keep them.
    // - activeForm: incoming wins, falling back to existing when omitted.
    //   (Pre-fix: incoming-undefined cleared the existing activeForm.)
    // - acceptanceCriteria: incoming wins (allows the agent to refine
    //   criteria mid-plan), falling back to existing when omitted.
    // - verifiedCriteria: incoming wins (the merge represents the
    //   agent's latest declared verification state). Re-validation
    //   against acceptanceCriteria already happened in readPlanSteps.
    return {
      step: update.step,
      status: update.status,
      ...(update.activeForm !== undefined
        ? { activeForm: update.activeForm }
        : s.activeForm !== undefined
          ? { activeForm: s.activeForm }
          : {}),
      ...(update.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: update.acceptanceCriteria }
        : s.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: s.acceptanceCriteria }
          : {}),
      ...(update.verifiedCriteria !== undefined
        ? { verifiedCriteria: update.verifiedCriteria }
        : s.verifiedCriteria !== undefined
          ? { verifiedCriteria: s.verifiedCriteria }
          : {}),
    };
  });
  const appended = new Set<string>();
  for (const s of incoming) {
    if (!existingTexts.has(s.step) && !appended.has(s.step)) {
      merged.push({
        step: s.step,
        status: s.status,
        ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
        ...(s.acceptanceCriteria !== undefined ? { acceptanceCriteria: s.acceptanceCriteria } : {}),
        ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
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
      // Duplicate-step check is a merge-mode concern only (the join key
      // collision); replace mode legitimately allows repeated step text.
      if (merge) {
        rejectDuplicateStepTextForMerge(incomingSteps);
      }

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

      // PR-11 review fix (Codex P1 #3105040898): re-validate closure
      // criteria on the MERGED plan. `readPlanSteps` enforces
      // acceptanceCriteria + verifiedCriteria coherence on the
      // incoming patch only — but merge can produce a step with
      // status "completed" while inherited acceptanceCriteria from
      // the prior snapshot remain unverified (the patch omits the
      // verifiedCriteria field, so the merged step keeps the prior
      // empty/partial verified set). Closure gate must reject these
      // so completion flows don't fire on unmet contracts.
      for (const step of plan) {
        if (step.status !== "completed") {
          continue;
        }
        const ac = step.acceptanceCriteria;
        if (!ac || ac.length === 0) {
          continue; // no criteria declared → no gate to enforce
        }
        const verified = new Set(
          (step.verifiedCriteria ?? []).map((c) => c.replace(/[\n\r]+/g, " ").trim()),
        );
        const unmet = ac.filter((c) => !verified.has(c.replace(/[\n\r]+/g, " ").trim()));
        if (unmet.length > 0) {
          const sample = unmet.slice(0, 3).join("; ");
          const more = unmet.length > 3 ? ` (+${unmet.length - 3} more)` : "";
          throw new ToolInputError(
            `merge would mark step "${step.step}" as completed with ${unmet.length} unverified ` +
              `acceptance criteria: ${sample}${more}. ` +
              `Either include the verified criteria in this update_plan call, or do not transition ` +
              `to status:"completed" until all acceptance criteria are met.`,
          );
        }
      }

      // Persist for next merge in this run. Snapshot stored as
      // `PlanStepSnapshot[]` (structural superset of `UpdatePlanStep[]`).
      // PR-9 Wave B1: include closure-gate fields so the persister and
      // UI can render acceptance / verified state after a refresh.
      if (ctx) {
        ctx.lastPlanSteps = plan.map<PlanStepSnapshot>((s) => ({
          step: s.step,
          status: s.status,
          ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
          ...(s.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: s.acceptanceCriteria }
            : {}),
          ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
        }));
      }

      // PR-9 Wave A2: detect plan completion. A plan is "complete" when
      // every step has terminal status ("completed" or "cancelled"). In
      // that case we emit a second event with phase: "completed" so the
      // gateway-side `plan-snapshot-persister` can auto-flip
      // `SessionEntry.planMode.mode` back to "normal". This addresses
      // the user's "does the plan actually close when complete?" concern
      // — previously the agent had to manually call `exit_plan_mode` or
      // toggle off via `/plan off`; now completion is structural.
      const allTerminal =
        plan.length > 0 && plan.every((s) => s.status === "completed" || s.status === "cancelled");

      // Emit `agent_plan_event` so channel renderers + control UI see updates.
      // Skip emit when we have no runId — that's the standalone/test path.
      //
      // PR-10 review fix (Codex P2 #3104743333 — option C selected):
      // include the structured `mergedSteps` (status/activeForm/
      // acceptanceCriteria/verifiedCriteria), not just step labels.
      // Under merge mode the tool INPUT is only a delta; UI subscribers
      // need the merged result to render the sidebar correctly. The
      // existing `steps` field stays as legacy for backwards compat.
      const mergedSteps = plan.map((s) => ({
        step: s.step,
        status: s.status,
        ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
        ...(s.acceptanceCriteria !== undefined ? { acceptanceCriteria: s.acceptanceCriteria } : {}),
        ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
      }));
      if (runId) {
        emitAgentPlanEvent({
          runId,
          ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          data: {
            phase: "update",
            title: "Plan updated",
            ...(explanation ? { explanation } : {}),
            steps: plan.map((s) => s.step),
            mergedSteps,
            source: "update_plan",
          },
        });
        if (allTerminal) {
          emitAgentPlanEvent({
            runId,
            ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
            data: {
              phase: "completed",
              title: "Plan complete",
              steps: plan.map((s) => s.step),
              mergedSteps,
              source: "update_plan",
            },
          });
        }
      }

      // PR-8 follow-up: return non-empty content. Empty content arrays
      // trip third-party transcript-pairing extensions (lossless-claw)
      // which inject `[lossless-claw] missing tool result` placeholders
      // into the agent's read-time context, polluting it with synthetic
      // errors. Non-empty content satisfies the pairing check and keeps
      // the agent's view of past turns clean.
      const stepCount = plan.length;
      const summaryLine = allTerminal
        ? `Plan complete (${stepCount} ${stepCount === 1 ? "step" : "steps"}).`
        : `Plan updated (${stepCount} ${stepCount === 1 ? "step" : "steps"}).`;
      return {
        content: [{ type: "text" as const, text: summaryLine }],
        details: {
          status: allTerminal ? ("completed" as const) : ("updated" as const),
          ...(explanation ? { explanation } : {}),
          plan,
        },
      };
    },
  };
}
