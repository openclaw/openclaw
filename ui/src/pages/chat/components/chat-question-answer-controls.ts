import type { Question } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { renderKbd } from "../../../components/kbd.ts";
import { t } from "../../../i18n/index.ts";

export function questionDraftValues(
  draft: QuestionDraft | undefined,
  question: Pick<Question, "isSecret" | "presentation" | "answerFormat">,
): string[] {
  const freeText = questionPreservesWhitespace(question) ? draft?.freeText : draft?.freeText.trim();
  const answerFormat = question.answerFormat;
  const custom = freeText ? (answerFormat === "lines" ? freeText.split(/\r?\n/u) : [freeText]) : [];
  return [...(draft?.selected ?? []), ...custom];
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
  const implicit = question.resource?.selection === "implicit";
  const options = question.options.filter(
    (option) => !implicit || props.selected.has(option.value ?? option.label),
  );
  const hasThumbnails = options.some((option) => option.thumbnail);
  return html`
    <div
      class="chat-question-panel__options"
      role=${question.multiSelect ? "group" : "radiogroup"}
      aria-label=${question.header}
    >
      ${options.map((option, index) => {
        const value = option.value ?? option.label;
        const selected = props.selected.has(value);
        const radioTabIndex = selected || (props.selected.size === 0 && index === 0) ? 0 : -1;
        return html`
          <button
            class="chat-question-panel__option ${
              selected ? "chat-question-panel__option--selected" : ""
            }"
            type="button"
            role=${implicit ? "button" : question.multiSelect ? "checkbox" : "radio"}
            aria-checked=${ifDefined(implicit ? undefined : selected ? "true" : "false")}
            aria-label=${ifDefined(implicit ? t("common.multiSelect.remove", { value: option.label }) : undefined)}
            tabindex=${question.multiSelect ? 0 : radioTabIndex}
            data-option-index=${index}
            ?disabled=${props.disabled}
            @click=${() => props.onSelect(value)}
          >
            <span class="chat-question-panel__option-marker" aria-hidden="true">
              ${implicit ? "−" : selected ? "✓" : ""}
            </span>
            ${hasThumbnails ? html`<span class="chat-question-panel__thumbnail" aria-hidden="true">${option.thumbnail?.startsWith("data:") ? html`<img src=${option.thumbnail} alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<span>◇</span>`}</span>` : nothing}
            <span class="chat-question-panel__option-copy">
              <strong class="chat-question-panel__option-label">${option.label}</strong>
              ${option.description ? html`<small>${option.description}</small>` : nothing}
            </span>
            ${index < 9 ? renderKbd(index + 1) : nothing}
          </button>
          ${option.thumbnail && !option.thumbnail.startsWith("data:") ? html`<a class="chat-question-panel__external-image" href=${option.thumbnail} target="_blank" rel="noreferrer noopener">${t("chat.externalImage.notLoaded")}: ${option.label} — ${t("chat.externalImage.open")}</a>` : nothing}
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
        aria-description=${t("chat.questions.multilineHint", { shortcut: "Ctrl/⌘+Enter" })}
        .value=${props.value}
        ?disabled=${props.disabled}
        @input=${handleInput}
      ></textarea>`;
}

export function renderQuestionFreeText(props: QuestionFreeTextProps) {
  const { question } = props;
  if (question.resource || (question.options.length > 0 && !question.isOther)) {
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
            ${question.options.length < 9 ? renderKbd(question.options.length + 1) : nothing}
          </label>`
    }
  `;
}

/** Defaults initialize presentation once; revisiting a field never restores a cleared answer. */
export function initializeQuestionDrafts(
  questions: readonly Question[],
  drafts: Map<string, QuestionDraft>,
): void {
  for (const question of questions) {
    if (drafts.has(question.questionId) || !question.defaultAnswers || question.isSecret) {
      continue;
    }
    const labels = new Set(question.options.map((option) => option.value ?? option.label));
    drafts.set(question.questionId, {
      selected: new Set(question.defaultAnswers.filter((value) => labels.has(value))),
      freeText: question.defaultAnswers
        .filter((value) => !labels.has(value))
        .join(question.answerFormat === "lines" ? "\n" : ""),
    });
  }
}

export function questionPreservesWhitespace(
  question: Pick<Question, "isSecret" | "presentation">,
): boolean {
  return question.isSecret === true || question.presentation === "form";
}
