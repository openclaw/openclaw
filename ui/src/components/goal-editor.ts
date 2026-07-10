// Goal-editor modal (Codex "Edit goal" style), opened from the composer mode selector.
//
// Reuses the .goal-dialog markup/classes (shared with the goal chip) and routes Save /
// Pause / Stop through the existing /goal set|edit|pause|resume|stop verbs — no new API.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { SessionGoal } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import "./modal-dialog.ts";

type GoalEditorProps = {
  /** Active goal being edited, or null when creating a new goal. */
  goal: SessionGoal | null;
  busy?: boolean;
  /** Sends a full `/goal …` command through the chat channel. */
  onSubmit: (command: string) => void;
  onClose: () => void;
};

const RESUMABLE = new Set(["paused", "blocked", "usage_limited", "budget_limited"]);

class GoalEditor extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: GoalEditorProps;

  @state() private objectiveDraft = "";
  @state() private budgetDraft = "";
  private seededGoalId: string | null = null;

  override willUpdate() {
    const goal = this.props?.goal ?? null;
    const key = goal?.id ?? "__new__";
    if (this.seededGoalId !== key) {
      this.seededGoalId = key;
      this.objectiveDraft = goal?.objective ?? "";
      this.budgetDraft = goal?.tokenBudget != null ? String(goal.tokenBudget) : "";
    }
  }

  private submit(): void {
    const objective = this.objectiveDraft.trim();
    if (!this.props || this.props.busy || !objective) {
      return;
    }
    const parsedBudget = Number.parseInt(this.budgetDraft.trim(), 10);
    const budgetSuffix =
      Number.isFinite(parsedBudget) && parsedBudget > 0 ? ` --budget ${parsedBudget}` : "";
    const verb = this.props.goal ? "edit" : "set";
    this.props.onSubmit(`/goal ${verb} ${objective}${budgetSuffix}`);
    this.props.onClose();
  }

  private command(command: string): void {
    if (!this.props || this.props.busy) {
      return;
    }
    this.props.onSubmit(command);
    this.props.onClose();
  }

  override render() {
    if (!this.props) {
      return nothing;
    }
    const goal = this.props.goal;
    const busy = this.props.busy ?? false;
    const canResume = goal ? RESUMABLE.has(goal.status) : false;
    const title = goal ? t("goal.editTitle") : t("goal.setTitle");
    return html`
      <openclaw-modal-dialog label=${title} @modal-cancel=${() => this.props?.onClose()}>
        <div class="goal-dialog">
          <label class="goal-dialog-field">
            <span class="goal-dialog-label">${t("goal.objective")}</span>
            <textarea
              class="goal-dialog-objective"
              rows="3"
              .value=${this.objectiveDraft}
              ?disabled=${busy}
              @input=${(event: Event) => {
                this.objectiveDraft = (event.target as HTMLTextAreaElement).value;
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
              ?disabled=${busy}
              @input=${(event: Event) => {
                this.budgetDraft = (event.target as HTMLInputElement).value;
              }}
            />
          </label>
          <div class="goal-dialog-actions">
            ${goal
              ? html`
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${busy}
                    @click=${() => this.command(canResume ? "/goal resume" : "/goal pause")}
                  >
                    ${canResume ? t("goal.resume") : t("goal.pause")}
                  </button>
                  <button
                    class="btn danger"
                    type="button"
                    ?disabled=${busy}
                    @click=${() => this.command("/goal stop")}
                  >
                    ${t("goal.stop")}
                  </button>
                `
              : nothing}
            <button
              class="btn"
              type="button"
              ?disabled=${busy}
              @click=${() => this.props?.onClose()}
            >
              ${t("goal.cancel")}
            </button>
            <button
              class="btn primary"
              type="button"
              data-goal-editor-save="true"
              ?disabled=${busy || this.objectiveDraft.trim().length === 0}
              @click=${() => this.submit()}
            >
              ${t("goal.save")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-goal-editor")) {
  customElements.define("openclaw-goal-editor", GoalEditor);
}

export type { GoalEditorProps, GoalEditor };
