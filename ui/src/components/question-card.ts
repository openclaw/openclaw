// Control UI component renders the ask_user_question card.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  QuestionCardAnswers,
  QuestionCardEntry,
  QuestionCardQuestion,
} from "../app/question-card.ts";
import "./modal-dialog.ts";
import { t } from "../i18n/index.ts";

/** Sentinel radio value for the free-text "Other" choice. */
export const OTHER_VALUE = "__other__";

type QuestionCardProps = {
  queue: readonly QuestionCardEntry[];
  busy: boolean;
  error: string | null;
  onSubmit: (id: string, answers: QuestionCardAnswers) => void | Promise<void>;
};

/** A per-question selection: an option index, or the free-text "Other" choice. */
export type Selection = { choice: string; otherText: string };

export function defaultSelection(): Selection {
  return { choice: "", otherText: "" };
}

/** Resolves the submitted answer text for a question + selection (shared by the inline card). */
export function resolveAnswerText(question: QuestionCardQuestion, selection: Selection): string {
  if (selection.choice === OTHER_VALUE) {
    return selection.otherText.trim();
  }
  const index = Number.parseInt(selection.choice, 10);
  const option = Number.isInteger(index) ? question.options[index] : undefined;
  return option ? option.label : "";
}

class QuestionCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: QuestionCardProps;

  // Keyed by `${cardId}:${questionId}` so selections persist across re-renders.
  @state() private selections = new Map<string, Selection>();

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private selectionKey(cardId: string, questionId: string): string {
    return `${cardId}:${questionId}`;
  }

  private getSelection(cardId: string, questionId: string): Selection {
    return this.selections.get(this.selectionKey(cardId, questionId)) ?? defaultSelection();
  }

  private updateSelection(cardId: string, questionId: string, patch: Partial<Selection>): void {
    const key = this.selectionKey(cardId, questionId);
    const next = new Map(this.selections);
    next.set(key, { ...this.getSelection(cardId, questionId), ...patch });
    this.selections = next;
  }

  private isCardComplete(card: QuestionCardEntry): boolean {
    return card.questions.every((question) => {
      const selection = this.getSelection(card.id, question.id);
      return resolveAnswerText(question, selection).length > 0;
    });
  }

  private handleSubmit(card: QuestionCardEntry): void {
    if (!this.props || this.props.busy || !this.isCardComplete(card)) {
      return;
    }
    const answers: QuestionCardAnswers = {};
    for (const question of card.questions) {
      answers[question.id] = {
        text: resolveAnswerText(question, this.getSelection(card.id, question.id)),
      };
    }
    // Clear this card's local selections; the queue update removes the card.
    const next = new Map(this.selections);
    for (const question of card.questions) {
      next.delete(this.selectionKey(card.id, question.id));
    }
    this.selections = next;
    void this.props.onSubmit(card.id, answers);
  }

  private renderOption(
    card: QuestionCardEntry,
    question: QuestionCardQuestion,
    optionIndex: number,
  ) {
    const option = question.options[optionIndex];
    const selection = this.getSelection(card.id, question.id);
    const value = String(optionIndex);
    return html`
      <label class="question-card-option">
        <input
          type="radio"
          name=${this.selectionKey(card.id, question.id)}
          .checked=${selection.choice === value}
          ?disabled=${this.props?.busy}
          @change=${() => this.updateSelection(card.id, question.id, { choice: value })}
        />
        <span class="question-card-option-label">
          ${optionIndex + 1}. ${option.label}
          ${optionIndex === 0
            ? html`<span class="question-card-recommended">${t("question.recommended")}</span>`
            : nothing}
        </span>
        ${option.description
          ? html`<span class="question-card-option-desc">${option.description}</span>`
          : nothing}
      </label>
    `;
  }

  private renderQuestion(card: QuestionCardEntry, question: QuestionCardQuestion) {
    const selection = this.getSelection(card.id, question.id);
    return html`
      <div class="question-card-question">
        <div class="question-card-header">${question.header}</div>
        <div class="question-card-prompt">${question.question}</div>
        ${question.isSecret
          ? html`<div class="question-card-secret">${t("question.secretWarning")}</div>`
          : nothing}
        ${question.options.map((_option, index) => this.renderOption(card, question, index))}
        ${question.isOther
          ? html`
              <label class="question-card-option">
                <input
                  type="radio"
                  name=${this.selectionKey(card.id, question.id)}
                  .checked=${selection.choice === OTHER_VALUE}
                  ?disabled=${this.props?.busy}
                  @change=${() =>
                    this.updateSelection(card.id, question.id, { choice: OTHER_VALUE })}
                />
                <span class="question-card-option-label">${t("question.otherLabel")}</span>
              </label>
              <input
                class="question-card-other-input"
                type="text"
                placeholder=${t("question.otherPlaceholder")}
                .value=${selection.otherText}
                ?disabled=${this.props?.busy}
                @input=${(event: Event) =>
                  this.updateSelection(card.id, question.id, {
                    choice: OTHER_VALUE,
                    otherText: (event.target as HTMLInputElement).value,
                  })}
              />
            `
          : nothing}
      </div>
    `;
  }

  override render() {
    const card = this.props?.queue[0];
    if (!this.props || !card) {
      return nothing;
    }
    const queueCount = this.props.queue.length;
    const title = t("question.title");
    return html`
      <openclaw-modal-dialog label=${title}>
        <div class="question-card">
          <div class="question-card-titlebar">
            <div class="question-card-title">${title}</div>
            ${queueCount > 1
              ? html`<div class="question-card-queue">
                  ${t("question.pending", { count: String(queueCount) })}
                </div>`
              : nothing}
          </div>
          ${card.questions.map((question) => this.renderQuestion(card, question))}
          ${this.props.error
            ? html`<div class="question-card-error">${this.props.error}</div>`
            : nothing}
          <div class="question-card-actions">
            <button
              class="btn primary"
              ?disabled=${this.props.busy || !this.isCardComplete(card)}
              @click=${() => this.handleSubmit(card)}
            >
              ${t("question.submit")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-question-card")) {
  customElements.define("openclaw-question-card", QuestionCard);
}
