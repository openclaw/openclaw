// Control UI Codex-parity plan-mode side panel.
//
// Renders the live plan checklist (from stream:plan), the plan-mode state chip, and the
// presented plan summary. Approve / Revise-with-feedback now live in the dedicated
// <openclaw-inline-plan-approval> card (Codex "Implement this plan?" swap-in).
import { html, nothing, type TemplateResult } from "lit";
import type { SessionPlanState } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  formatPlanProgress,
  formatPlanStateLabel,
  planStepStatusLabel,
  type PlanChecklist,
  type PlanChecklistStepStatus,
} from "../../../lib/session-plan.ts";

export type PlanPanelActions = {
  onExit?: () => void;
  onViewDocument?: () => void;
};

export type PlanPanelProps = {
  plan?: SessionPlanState | null;
  checklist?: PlanChecklist | null;
  actions?: PlanPanelActions;
};

function stepStatusIcon(status: PlanChecklistStepStatus): TemplateResult {
  switch (status) {
    case "completed":
      return icons.check;
    case "in_progress":
      return icons.play;
    case "pending":
      return icons.circle;
  }
  const unreachable: never = status;
  return unreachable;
}

function renderChecklist(checklist: PlanChecklist | null | undefined): TemplateResult {
  const steps = checklist?.steps ?? [];
  if (steps.length === 0) {
    return html`<p class="plan-panel__empty">${t("plan.empty")}</p>`;
  }
  return html`
    <ol class="plan-panel__steps" aria-label=${t("plan.checklist")}>
      ${steps.map(
        (entry) => html`
          <li class="plan-panel__step plan-panel__step--${entry.status}">
            <span class="plan-panel__step-icon" aria-hidden="true">
              ${stepStatusIcon(entry.status)}
            </span>
            <span class="plan-panel__step-status-label">${planStepStatusLabel(entry.status)}</span>
            <span class="plan-panel__step-text">${entry.step}</span>
          </li>
        `,
      )}
    </ol>
  `;
}

/** Renders the plan-mode side panel, or nothing when the session is not in plan mode. */
export function renderPlanPanel(props: PlanPanelProps): TemplateResult | typeof nothing {
  const plan = props.plan;
  if (!plan) {
    return nothing;
  }
  const actions = props.actions ?? {};
  const progress = formatPlanProgress(props.checklist?.steps ?? []);
  return html`
    <section
      class="plan-panel plan-panel--${plan.status}"
      data-plan-panel="true"
      data-plan-state=${plan.status}
      role="complementary"
      aria-label=${t("plan.title")}
    >
      <header class="plan-panel__header">
        <span class="plan-panel__header-icon" aria-hidden="true">${icons.scrollText}</span>
        <span class="plan-panel__title">${t("plan.title")}</span>
        <span class="plan-panel__chip plan-panel__chip--${plan.status}" data-plan-chip="true">
          ${formatPlanStateLabel(plan.status)}
        </span>
        ${progress ? html`<span class="plan-panel__progress">${progress}</span>` : nothing}
      </header>

      ${props.checklist?.explanation
        ? html`<p class="plan-panel__explanation">${props.checklist.explanation}</p>`
        : nothing}
      ${renderChecklist(props.checklist)}
      ${plan.lastSummary
        ? html`
            <details class="plan-panel__summary">
              <summary>${t("plan.summary")}</summary>
              <div class="plan-panel__summary-body">${plan.lastSummary}</div>
            </details>
          `
        : nothing}
      ${plan.planFilePath && actions.onViewDocument
        ? html`
            <button
              class="plan-panel__doc-button"
              type="button"
              @click=${() => actions.onViewDocument?.()}
            >
              ${icons.fileText} ${t("plan.viewDocument")}
            </button>
          `
        : nothing}
    </section>
  `;
}
