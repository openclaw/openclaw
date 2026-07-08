// Control UI module implements Codex-parity plan-mode presentation helpers.
import type { SessionPlanState } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export type PlanChecklistStepStatus = "pending" | "in_progress" | "completed";

export type PlanChecklistStep = {
  step: string;
  status: PlanChecklistStepStatus;
};

/** Live plan checklist derived from the latest stream:plan (update_plan) event. */
export type PlanChecklist = {
  explanation?: string;
  steps: PlanChecklistStep[];
};

/** Human label for the plan-mode state chip. */
export function formatPlanStateLabel(status: SessionPlanState["status"]): string {
  switch (status) {
    case "planning":
      return t("plan.state.planning");
    case "pending_approval":
      return t("plan.state.awaitingApproval");
  }
  const unreachable: never = status;
  return unreachable;
}

/** Status glyph for a checklist step (mirrors codex plan_spec: one step in_progress). */
export function planStepStatusIcon(status: PlanChecklistStepStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "▶";
    case "pending":
      return "○";
  }
  const unreachable: never = status;
  return unreachable;
}

/** Accessible status label for a checklist step. */
export function planStepStatusLabel(status: PlanChecklistStepStatus): string {
  switch (status) {
    case "completed":
      return t("plan.step.completed");
    case "in_progress":
      return t("plan.step.inProgress");
    case "pending":
      return t("plan.step.pending");
  }
  const unreachable: never = status;
  return unreachable;
}

/** Short progress summary, e.g. "2/5 done". */
export function formatPlanProgress(steps: PlanChecklistStep[]): string | null {
  if (steps.length === 0) {
    return null;
  }
  const done = steps.filter((entry) => entry.status === "completed").length;
  return t("plan.progress", { done: String(done), total: String(steps.length) });
}
