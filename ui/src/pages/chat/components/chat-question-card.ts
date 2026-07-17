import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import type { QuestionStatus } from "../tool-stream.ts";

type QuestionCardProps = {
  status: QuestionStatus;
  disabled: boolean;
  onSubmit: (answers: Record<string, string>, onRejected: () => void) => void;
};

class ChatQuestionCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: QuestionCardProps;
  @state() private answers = new Map<string, string>();
  @state() private freeFormAnswers = new Set<string>();
  @state() private submitted = false;
  private requestKey: string | null = null;

  override willUpdate() {
    const status = this.props?.status;
    const nextRequestKey = status ? `${status.itemId}:${status.actionToken}` : null;
    if (nextRequestKey !== this.requestKey) {
      this.requestKey = nextRequestKey;
      this.answers = new Map();
      this.freeFormAnswers = new Set();
      this.submitted = false;
    }
  }

  private setAnswer(questionId: string, answer: string, source: "option" | "text"): void {
    this.answers = new Map(this.answers).set(questionId, answer);
    const freeFormAnswers = new Set(this.freeFormAnswers);
    if (source === "text") {
      freeFormAnswers.add(questionId);
    } else {
      freeFormAnswers.delete(questionId);
    }
    this.freeFormAnswers = freeFormAnswers;
  }

  private submit(status: QuestionStatus): void {
    if (!status.questions.every((question) => this.answers.get(question.id)?.trim())) {
      return;
    }
    const answers = Object.fromEntries(
      status.questions.map((question) => [question.id, this.answers.get(question.id)!]),
    );
    this.submitted = true;
    this.props?.onSubmit(answers, () => {
      this.submitted = false;
    });
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const complete = props.status.questions.every((question) =>
      Boolean(this.answers.get(question.id)?.trim()),
    );
    return html`
      <section class="chat-question" role="group" aria-label=${t("chat.questions.title")}>
        <div class="chat-question__title">${t("chat.questions.title")}</div>
        ${props.status.questions.map(
          (question) => html`
            <fieldset class="chat-question__field">
              <legend>${question.header}</legend>
              <div class="chat-question__prompt">${question.question}</div>
              ${question.options.map(
                (option) => html`
                  <label class="chat-question__option">
                    <input
                      type="radio"
                      name=${`${props.status.itemId}-${question.id}`}
                      .checked=${this.answers.get(question.id) === option.label}
                      ?disabled=${props.disabled || this.submitted}
                      @change=${() => this.setAnswer(question.id, option.label, "option")}
                    />
                    <span>
                      <strong>${option.label}</strong>
                      ${option.description ? html`<small>${option.description}</small>` : nothing}
                    </span>
                  </label>
                `,
              )}
              ${question.isOther || question.options.length === 0
                ? html`
                    <input
                      class="chat-question__other"
                      type="text"
                      autocomplete="off"
                      placeholder=${t("chat.questions.other")}
                      .value=${this.freeFormAnswers.has(question.id)
                        ? (this.answers.get(question.id) ?? "")
                        : ""}
                      ?disabled=${props.disabled || this.submitted}
                      @input=${(event: Event) =>
                        this.setAnswer(
                          question.id,
                          (event.target as HTMLInputElement).value,
                          "text",
                        )}
                    />
                  `
                : nothing}
            </fieldset>
          `,
        )}
        <button
          class="btn btn--sm primary chat-question__submit"
          type="button"
          ?disabled=${props.disabled || this.submitted || !complete}
          @click=${() => this.submit(props.status)}
        >
          ${t("chat.questions.submit")}
        </button>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-question")) {
  customElements.define("openclaw-chat-question", ChatQuestionCard);
}
