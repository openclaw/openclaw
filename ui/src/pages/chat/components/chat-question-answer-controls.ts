import type { Question } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";

export function questionDraftValues(draft: QuestionDraft | undefined, isSecret = false): string[] {
  const freeText = isSecret ? draft?.freeText : draft?.freeText.trim();
  return [...(draft?.selected ?? []), ...(freeText ? [freeText] : [])];
}

type QuestionOptionsProps = {
  question: Question;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (label: string) => void;
};

type QuestionFreeTextProps = {
  question: Question;
  value: string;
  selected: boolean;
  disabled: boolean;
  onInput: (value: string) => void;
};

export function renderQuestionOptions(props: QuestionOptionsProps) {
  const { question } = props;
  if (question.options.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-question-panel__options"
      role=${question.multiSelect ? "group" : "radiogroup"}
      aria-label=${question.header}
    >
      ${question.options.map((option, index) => {
        const selected = props.selected.has(option.label);
        const radioTabIndex = selected || (props.selected.size === 0 && index === 0) ? 0 : -1;
        return html`
          <button
            class="chat-question-panel__option ${
              selected ? "chat-question-panel__option--selected" : ""
            }"
            type="button"
            role=${question.multiSelect ? "checkbox" : "radio"}
            aria-checked=${selected ? "true" : "false"}
            tabindex=${question.multiSelect ? 0 : radioTabIndex}
            data-option-index=${index}
            ?disabled=${props.disabled}
            @click=${() => props.onSelect(option.label)}
          >
            <span class="chat-question-panel__option-marker" aria-hidden="true">
              ${selected ? "✓" : ""}
            </span>
            <span class="chat-question-panel__option-copy">
              <strong>${option.label}</strong>
              ${option.description ? html`<small>${option.description}</small>` : nothing}
            </span>
            <kbd>${index + 1}</kbd>
          </button>
        `;
      })}
    </div>
  `;
}

function renderFreeTextControl(
  props: QuestionFreeTextProps,
  className: string,
  placeholder: string,
  label?: string,
) {
  const handleInput = (event: Event) => {
    if (
      event.currentTarget instanceof HTMLInputElement ||
      event.currentTarget instanceof HTMLTextAreaElement
    ) {
      props.onInput(event.currentTarget.value);
    }
  };
  return props.question.isSecret
    ? html`<input
        class=${className}
        type="password"
        autocomplete="off"
        placeholder=${placeholder}
        aria-label=${ifDefined(label)}
        .value=${props.value}
        ?disabled=${props.disabled}
        @input=${handleInput}
      />`
    : html`<textarea
        class="${className} chat-question-panel__textarea"
        rows="1"
        placeholder=${placeholder}
        aria-label=${ifDefined(label)}
        aria-description=${t("chat.questions.multilineHint")}
        .value=${props.value}
        ?disabled=${props.disabled}
        @input=${handleInput}
      ></textarea>`;
}

export function renderQuestionFreeText(props: QuestionFreeTextProps) {
  const { question } = props;
  if (question.options.length > 0 && !question.isOther) {
    return nothing;
  }
  const answerLabel = question.header || t("chat.questions.answer");
  return html`
    ${
      question.options.length === 0
        ? html`<label class="field">
            <span>${answerLabel}</span>
            ${renderFreeTextControl(
              props,
              "input",
              t("chat.questions.answerPlaceholder", {
                label: question.secretStore?.name ?? answerLabel,
              }),
            )}
          </label>`
        : html`<label
            class="chat-question-panel__option chat-question-panel__option--other ${
              props.selected ? "chat-question-panel__option--selected" : ""
            }"
          >
            <span class="chat-question-panel__option-marker" aria-hidden="true"></span>
            ${renderFreeTextControl(
              props,
              "chat-question-panel__other",
              t("chat.questions.other"),
              t("chat.questions.ownAnswerFor", { header: question.header }),
            )}
            <kbd>${question.options.length + 1}</kbd>
          </label>`
    }
    ${
      question.isSecret
        ? nothing
        : html`<div class="chat-question-panel__input-hint">
            ${t("chat.questions.multilineHint")}
          </div>`
    }
  `;
}
