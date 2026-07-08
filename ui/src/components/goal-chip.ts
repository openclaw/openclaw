// Control UI component renders the persistent "Pursuing goal" chip plus an
// edit-goal dialog (objective + budget + pause/resume/stop), mirroring the
// question-card structure. Driven by `goal.updated` events; actions route back
// through the existing `/goal` host verbs.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GoalChipEntry, GoalChipStatus } from "../app/goal-chip.ts";
import { t } from "../i18n/index.ts";
import "./modal-dialog.ts";

export type GoalChipAction = "pause" | "resume" | "stop" | "edit";

export type GoalChipActionPayload = {
  objective?: string;
  tokenBudget?: number;
};

type GoalChipProps = {
  goal: GoalChipEntry | null;
  busy: boolean;
  error: string | null;
  onAction: (action: GoalChipAction, payload?: GoalChipActionPayload) => void | Promise<void>;
};

/** Statuses whose canonical resume path is `/goal resume`. */
const RESUMABLE: ReadonlySet<GoalChipStatus> = new Set([
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
]);

function statusLabel(status: GoalChipStatus): string {
  switch (status) {
    case "active":
      return t("goal.statusActive");
    case "paused":
      return t("goal.statusPaused");
    case "blocked":
      return t("goal.statusBlocked");
    case "usage_limited":
      return t("goal.statusUsageLimited");
    case "budget_limited":
      return t("goal.statusBudgetLimited");
    case "complete":
      return t("goal.statusComplete");
  }
}

class GoalChip extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: GoalChipProps;

  @state() private editing = false;
  @state() private objectiveDraft = "";
  @state() private budgetDraft = "";

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private openEditor(goal: GoalChipEntry): void {
    this.objectiveDraft = goal.objective;
    this.budgetDraft = goal.tokenBudget != null ? String(goal.tokenBudget) : "";
    this.editing = true;
  }

  private closeEditor(): void {
    this.editing = false;
  }

  private dispatch(action: GoalChipAction, payload?: GoalChipActionPayload): void {
    if (!this.props || this.props.busy) {
      return;
    }
    void this.props.onAction(action, payload);
  }

  private handleSaveEdit(): void {
    const objective = this.objectiveDraft.trim();
    if (!objective) {
      return;
    }
    const parsedBudget = Number.parseInt(this.budgetDraft.trim(), 10);
    const tokenBudget =
      Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : undefined;
    this.dispatch("edit", { objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) });
    this.closeEditor();
  }

  private renderUsage(goal: GoalChipEntry) {
    if (goal.tokensUsed == null) {
      return nothing;
    }
    const text =
      goal.tokenBudget != null
        ? t("goal.usageWithBudget", {
            used: String(goal.tokensUsed),
            budget: String(goal.tokenBudget),
          })
        : t("goal.usage", { used: String(goal.tokensUsed) });
    return html`<span class="goal-chip-usage">${text}</span>`;
  }

  private renderDialog(goal: GoalChipEntry) {
    const canResume = RESUMABLE.has(goal.status);
    return html`
      <openclaw-modal-dialog label=${t("goal.editTitle")} @modal-cancel=${() => this.closeEditor()}>
        <div class="goal-dialog">
          <label class="goal-dialog-field">
            <span class="goal-dialog-label">${t("goal.objective")}</span>
            <textarea
              class="goal-dialog-objective"
              rows="3"
              .value=${this.objectiveDraft}
              ?disabled=${this.props?.busy}
              @input=${(e: Event) => {
                this.objectiveDraft = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
          </label>
          <label class="goal-dialog-field">
            <span class="goal-dialog-label">${t("goal.budget")}</span>
            <input
              class="goal-dialog-budget"
              type="number"
              min="1"
              placeholder=${t("goal.budgetPlaceholder")}
              .value=${this.budgetDraft}
              ?disabled=${this.props?.busy}
              @input=${(e: Event) => {
                this.budgetDraft = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          ${this.props?.error
            ? html`<div class="goal-dialog-error">${this.props.error}</div>`
            : nothing}
          <div class="goal-dialog-actions">
            ${canResume
              ? html`<button
                  class="btn"
                  ?disabled=${this.props?.busy}
                  @click=${() => {
                    this.dispatch("resume");
                    this.closeEditor();
                  }}
                >
                  ${t("goal.resume")}
                </button>`
              : html`<button
                  class="btn"
                  ?disabled=${this.props?.busy}
                  @click=${() => {
                    this.dispatch("pause");
                    this.closeEditor();
                  }}
                >
                  ${t("goal.pause")}
                </button>`}
            <button
              class="btn danger"
              ?disabled=${this.props?.busy}
              @click=${() => {
                this.dispatch("stop");
                this.closeEditor();
              }}
            >
              ${t("goal.stop")}
            </button>
            <button
              class="btn primary"
              ?disabled=${this.props?.busy || this.objectiveDraft.trim().length === 0}
              @click=${() => this.handleSaveEdit()}
            >
              ${t("goal.save")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
  }

  override render() {
    const goal = this.props?.goal;
    if (!this.props || !goal) {
      return nothing;
    }
    const label = goal.status === "active" ? t("goal.pursuing") : t("goal.title");
    return html`
      <button
        class="goal-chip goal-chip--${goal.status}"
        title=${goal.objective}
        ?disabled=${this.props.busy}
        @click=${() => this.openEditor(goal)}
      >
        <span class="goal-chip-label">${label}</span>
        <span class="goal-chip-objective">${goal.objective}</span>
        <span class="goal-chip-status">${statusLabel(goal.status)}</span>
        ${this.renderUsage(goal)}
      </button>
      ${this.editing ? this.renderDialog(goal) : nothing}
    `;
  }
}

if (!customElements.get("openclaw-goal-chip")) {
  customElements.define("openclaw-goal-chip", GoalChip);
}

export type { GoalChip };
