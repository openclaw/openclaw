// Composer-inline ask_user_question card (Codex-style swap-in).
//
// Renders a pending question as an inline card in the chat composer status-stack
// instead of a page-locking modal. Reuses the question-card content classes and
// answer-resolution helpers; resolution still flows through question.resolve via
// the global QuestionManager (the host wires onSubmit → overlays.submitQuestionAnswers).
// One question shows at a time with "N of M" paging when a card bundles 1-3 questions.
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { QuestionCardEntry, QuestionCardQuestion } from "../app/question-card.ts";
import type { QuestionCardAnswers } from "../app/question-card.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import {
  OTHER_VALUE,
  defaultSelection,
  resolveAnswerText,
  type Selection,
} from "./question-card.ts";

type InlineQuestionProps = {
  entry: QuestionCardEntry;
  busy: boolean;
  error: string | null;
  onSubmit: (id: string, answers: QuestionCardAnswers) => void | Promise<void>;
  onDismiss: () => void;
};

class InlineQuestionCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: InlineQuestionProps;

  // Selections keyed by question id; reset when the card id changes.
  @state() private selections = new Map<string, Selection>();
  @state() private page = 0;
  private cardId: string | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  override willUpdate() {
    const nextId = this.props?.entry.id ?? null;
    if (nextId !== this.cardId) {
      this.cardId = nextId;
      this.selections = new Map();
      this.page = 0;
    }
  }

  private getSelection(questionId: string): Selection {
    return this.selections.get(questionId) ?? defaultSelection();
  }

  private updateSelection(questionId: string, patch: Partial<Selection>): void {
    const next = new Map(this.selections);
    next.set(questionId, { ...this.getSelection(questionId), ...patch });
    this.selections = next;
  }

  private isComplete(entry: QuestionCardEntry): boolean {
    return entry.questions.every(
      (question) => resolveAnswerText(question, this.getSelection(question.id)).length > 0,
    );
  }

  private handleSubmit(entry: QuestionCardEntry): void {
    if (!this.props || this.props.busy || !this.isComplete(entry)) {
      return;
    }
    const answers: QuestionCardAnswers = {};
    for (const question of entry.questions) {
      answers[question.id] = { text: resolveAnswerText(question, this.getSelection(question.id)) };
    }
    void this.props.onSubmit(entry.id, answers);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      this.props?.onDismiss();
    }
  }

  private renderOption(question: QuestionCardQuestion, optionIndex: number) {
    const option = question.options[optionIndex];
    const selection = this.getSelection(question.id);
    const value = String(optionIndex);
    return html`
      <label class="question-card-option">
        <input
          type="radio"
          name="inline-${question.id}"
          .checked=${selection.choice === value}
          ?disabled=${this.props?.busy}
          @change=${() => this.updateSelection(question.id, { choice: value })}
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

  private renderQuestion(question: QuestionCardQuestion) {
    const selection = this.getSelection(question.id);
    return html`
      <div class="question-card-question">
        <div class="question-card-header">${question.header}</div>
        <div class="question-card-prompt">${question.question}</div>
        ${question.isSecret
          ? html`<div class="question-card-secret">${t("question.secretWarning")}</div>`
          : nothing}
        ${question.options.map((_option, index) => this.renderOption(question, index))}
        <label class="question-card-option">
          <input
            type="radio"
            name="inline-${question.id}"
            .checked=${selection.choice === OTHER_VALUE}
            ?disabled=${this.props?.busy}
            @change=${() => this.updateSelection(question.id, { choice: OTHER_VALUE })}
          />
          <span class="question-card-option-label">${t("question.otherInlineLabel")}</span>
        </label>
        <input
          class="question-card-other-input"
          type="text"
          placeholder=${t("question.otherPlaceholder")}
          .value=${selection.otherText}
          ?disabled=${this.props?.busy}
          @input=${(event: Event) =>
            this.updateSelection(question.id, {
              choice: OTHER_VALUE,
              otherText: (event.target as HTMLInputElement).value,
            })}
        />
      </div>
    `;
  }

  override render() {
    const entry = this.props?.entry;
    if (!this.props || !entry || entry.questions.length === 0) {
      return nothing;
    }
    const total = entry.questions.length;
    const page = Math.min(this.page, total - 1);
    const question = entry.questions[page];
    return html`
      <section
        class="inline-question"
        role="group"
        aria-label=${t("question.title")}
        @keydown=${(event: KeyboardEvent) => this.handleKeydown(event)}
      >
        <header class="inline-question__header">
          <span class="inline-question__icon" aria-hidden="true">${icons.messageSquare}</span>
          <span class="inline-question__title">${t("question.title")}</span>
          ${total > 1
            ? html`
                <span class="inline-question__paging">
                  <button
                    class="inline-question__page-btn inline-question__page-btn--prev"
                    type="button"
                    ?disabled=${page === 0}
                    aria-label=${t("question.previous")}
                    @click=${() => {
                      this.page = Math.max(0, page - 1);
                    }}
                  >
                    ${icons.chevronRight}
                  </button>
                  <span class="inline-question__page-indicator">
                    ${t("question.pageIndicator", {
                      current: String(page + 1),
                      total: String(total),
                    })}
                  </span>
                  <button
                    class="inline-question__page-btn"
                    type="button"
                    ?disabled=${page === total - 1}
                    aria-label=${t("question.next")}
                    @click=${() => {
                      this.page = Math.min(total - 1, page + 1);
                    }}
                  >
                    ${icons.chevronRight}
                  </button>
                </span>
              `
            : nothing}
        </header>
        ${this.renderQuestion(question)}
        ${this.props.error
          ? html`<div class="question-card-error">${this.props.error}</div>`
          : nothing}
        <div class="inline-question__actions">
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.props.busy}
            @click=${() => this.props?.onDismiss()}
          >
            ${t("question.dismiss")}
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${this.props.busy || !this.isComplete(entry)}
            @click=${() => this.handleSubmit(entry)}
          >
            ${t("question.submit")}
          </button>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-inline-question")) {
  customElements.define("openclaw-inline-question", InlineQuestionCard);
}

export type { InlineQuestionProps, InlineQuestionCard };
