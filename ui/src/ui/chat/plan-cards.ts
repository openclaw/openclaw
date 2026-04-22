/**
 * Plan card rendering for the webchat message thread.
 *
 * Renders agent plan events as expandable cards with step checklists.
 * Uses the same <details>/<summary> pattern as tool cards for consistency.
 */

import { html, nothing, type TemplateResult } from "lit";

export interface PlanCardData {
  title: string;
  explanation?: string;
  steps: PlanCardStep[];
  source?: string;
}

export interface PlanCardStep {
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;
}

const STATUS_MARKERS: Record<PlanCardStep["status"], string> = {
  pending: "⬚",
  in_progress: "⏳",
  completed: "✅",
  cancelled: "❌",
};

const PLAN_ICON = html`<svg
  class="chat-plan-card__icon"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M9 11l3 3L22 4" />
  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
</svg>`;

const CHEVRON_ICON = html`<svg
  class="chat-plan-card__chevron"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M9 18l6-6-6-6" />
</svg>`;

/**
 * Renders a plan card as an expandable <details> element.
 */
export function renderPlanCard(plan: PlanCardData): TemplateResult {
  const stepCount = plan.steps.length;
  const completedCount = plan.steps.filter((s) => s.status === "completed").length;
  const meta = completedCount > 0 ? `${completedCount}/${stepCount} done` : `${stepCount} steps`;

  return html`
    <details class="chat-plan-card">
      <summary>
        ${PLAN_ICON}
        <span class="chat-plan-card__title">${plan.title}</span>
        <span class="chat-plan-card__meta">${meta}</span>
        ${CHEVRON_ICON}
      </summary>
      <div class="chat-plan-card__body">
        ${plan.explanation
          ? html`<div class="chat-plan-card__explanation">${plan.explanation}</div>`
          : nothing}
        <ul class="chat-plan-card__steps">
          ${plan.steps.map((step) => renderPlanStep(step))}
        </ul>
      </div>
    </details>
  `;
}

function renderPlanStep(step: PlanCardStep): TemplateResult {
  const label = step.status === "in_progress" && step.activeForm ? step.activeForm : step.text;
  const marker = STATUS_MARKERS[step.status] ?? "⬚";
  const statusClass = `chat-plan-card__step--${step.status.replace("_", "-")}`;

  return html`
    <li class="chat-plan-card__step ${statusClass}">
      <span class="chat-plan-card__step-marker">${marker}</span>
      <span>${label}</span>
    </li>
  `;
}

/**
 * Formats a plan as markdown for sidebar/detail view.
 */
export function formatPlanAsMarkdown(plan: PlanCardData): string {
  const clean = (s: string) => s.replace(/[\n\r]+/g, " ").trim();
  const lines = [`## ${clean(plan.title)}`];
  if (plan.explanation) {
    lines.push("", `_${clean(plan.explanation)}_`);
  }
  lines.push("");
  for (const step of plan.steps) {
    const rawLabel = step.status === "in_progress" && step.activeForm ? step.activeForm : step.text;
    const label = clean(rawLabel);
    if (step.status === "completed") {
      lines.push(`- [x] ${label}`);
    } else if (step.status === "cancelled") {
      lines.push(`- [ ] ~~${label}~~ (cancelled)`);
    } else if (step.status === "in_progress") {
      lines.push(`- [ ] **${label}** (in progress)`);
    } else {
      lines.push(`- [ ] ${label}`);
    }
  }
  return lines.join("\n");
}
