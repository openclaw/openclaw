import {
  getSupervisorMilestoneModelInputDraft,
  getSupervisorPresentationPlanItem,
} from "./presentation.js";
import type {
  SupervisorMilestoneModelInputDraft,
  SupervisorMilestonePreparedPrompt,
  SupervisorMilestoneRuntimeEnvelope,
  SupervisorPresentationPlan,
  SupervisorPresentationPlanItem,
} from "./types.js";

export type SupervisorMilestoneConsumptionInput = {
  plan: SupervisorPresentationPlan;
};

export type SupervisorMilestoneConsumptionResult =
  | {
      consumed: false;
      reason: string;
      draft?: SupervisorMilestoneModelInputDraft;
    }
  | {
      consumed: true;
      draft: SupervisorMilestoneModelInputDraft;
      item: SupervisorPresentationPlanItem;
    };

export type SupervisorMilestonePreparationResult =
  | {
      prepared: false;
      reason: string;
      prompt?: SupervisorMilestonePreparedPrompt;
      runtimeEnvelope?: SupervisorMilestoneRuntimeEnvelope;
      draft?: SupervisorMilestoneModelInputDraft;
    }
  | {
      prepared: true;
      prompt: SupervisorMilestonePreparedPrompt;
      runtimeEnvelope: SupervisorMilestoneRuntimeEnvelope;
      draft: SupervisorMilestoneModelInputDraft;
      item: SupervisorPresentationPlanItem;
    };

/**
 * Thin seam for future milestone generation.
 * Current behavior is intentionally non-emitting: it only exposes whether a
 * draft exists and whether the planner currently allows milestone generation.
 */
export function consumeSupervisorMilestoneDraft(
  input: SupervisorMilestoneConsumptionInput,
): SupervisorMilestoneConsumptionResult {
  const item = getSupervisorPresentationPlanItem(input.plan, "milestone");
  const draft = getSupervisorMilestoneModelInputDraft(input.plan);
  if (!item || !draft) {
    return {
      consumed: false,
      reason: "no_milestone_draft",
    };
  }
  if (!item.enabled || item.mode !== "model") {
    return {
      consumed: false,
      reason: item.reason,
      draft,
    };
  }
  return {
    consumed: true,
    draft,
    item,
  };
}

export function prepareSupervisorMilestonePrompt(
  input: SupervisorMilestoneConsumptionInput,
): SupervisorMilestonePreparationResult {
  const consumed = consumeSupervisorMilestoneDraft(input);
  if (!consumed.consumed) {
    const draft = consumed.draft;
    return {
      prepared: false,
      reason: consumed.reason,
      draft,
      prompt: draft
        ? {
            audience_question: draft.audience_question,
            semantic_role: draft.semantic_role,
            prompt_hint: draft.prompt_hint,
          }
        : undefined,
      runtimeEnvelope: draft
        ? {
            prompt_slots: {
              audience_question: draft.audience_question,
              semantic_role: draft.semantic_role,
              prompt_hint: draft.prompt_hint,
            },
            planner: {
              suppress_reason: draft.suppress_reason ?? consumed.reason,
              semantic_role: draft.semantic_role,
            },
          }
        : undefined,
    };
  }
  return {
    prepared: true,
    draft: consumed.draft,
    item: consumed.item,
    prompt: {
      audience_question: consumed.draft.audience_question,
      semantic_role: consumed.draft.semantic_role,
      prompt_hint: consumed.draft.prompt_hint,
    },
    runtimeEnvelope: {
      prompt_slots: {
        audience_question: consumed.draft.audience_question,
        semantic_role: consumed.draft.semantic_role,
        prompt_hint: consumed.draft.prompt_hint,
      },
      planner: {
        suppress_reason: consumed.draft.suppress_reason,
        semantic_role: consumed.draft.semantic_role,
      },
    },
  };
}
