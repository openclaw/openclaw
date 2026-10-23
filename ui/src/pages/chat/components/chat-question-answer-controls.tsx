import type { Question } from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  adjustTextareaHeight,
  handleTextareaOverflowInteraction,
  handleTextareaOverflowScroll,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
} from "./chat-composer-dom.ts";

type QuestionOptionsProps = {
  question: Question;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (label: string) => void;
  optionRef?: (element: HTMLButtonElement) => () => void;
};

type QuestionFreeTextProps = {
  getTranscriptElement?: () => HTMLElement | null;
  question: Question;
  value: string;
  selected: boolean;
  disabled: boolean;
  onInput: (value: string) => void;
  inputRef?: (element: HTMLInputElement | HTMLTextAreaElement) => void;
};

function Shortcut(props: { value: number }) {
  return (
    <kbd class="shortcut-kbd">
      <span class="kbd__text">{props.value}</span>
    </kbd>
  );
}

export function QuestionOptions(props: QuestionOptionsProps) {
  const implicit = () => props.question.resource?.selection === "implicit";
  const options = createMemo(() =>
    props.question.options.filter(
      (option) => !implicit() || props.selected.has(option.value ?? option.label),
    ),
  );
  const hasThumbnails = createMemo(() => options().some((option) => option.thumbnail));
  return (
    <>
      {props.question.options.length > 0 && (
        <div
          class="chat-question-panel__options"
          role={props.question.multiSelect ? "group" : "radiogroup"}
          aria-label={props.question.header}
        >
          <For each={options()}>
            {(option, index) => {
              const value = () => option.value ?? option.label;
              const selected = () => props.selected.has(value());
              let releaseOption: (() => void) | undefined;
              onSettled(() => () => releaseOption?.());
              return (
                <>
                  <button
                    ref={(element) => {
                      releaseOption = props.optionRef?.(element);
                    }}
                    class={[
                      "chat-question-panel__option",
                      { "chat-question-panel__option--selected": selected() },
                    ]}
                    type="button"
                    role={implicit() ? "button" : props.question.multiSelect ? "checkbox" : "radio"}
                    aria-checked={implicit() ? undefined : selected() ? "true" : "false"}
                    aria-label={
                      implicit()
                        ? t("common.multiSelect.remove", { value: option.label })
                        : undefined
                    }
                    tabindex={
                      props.question.multiSelect ||
                      selected() ||
                      (props.selected.size === 0 && index() === 0)
                        ? 0
                        : -1
                    }
                    data-option-index={index()}
                    disabled={props.disabled}
                    onClick={() => props.onSelect(value())}
                  >
                    <span class="chat-question-panel__option-marker" aria-hidden="true">
                      {implicit() ? "−" : selected() ? "✓" : ""}
                    </span>
                    {hasThumbnails() && (
                      <span class="chat-question-panel__thumbnail" aria-hidden="true">
                        {option.thumbnail?.startsWith("data:") ? (
                          <img
                            src={option.thumbnail}
                            alt=""
                            loading="lazy"
                            referrerpolicy="no-referrer"
                          />
                        ) : (
                          <span>◇</span>
                        )}
                      </span>
                    )}
                    <span class="chat-question-panel__option-copy">
                      <strong class="chat-question-panel__option-label">{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {index() < 9 && <Shortcut value={index() + 1} />}
                  </button>
                  {option.thumbnail && !option.thumbnail?.startsWith("data:") && (
                    <a
                      class="chat-question-panel__external-image"
                      href={option.thumbnail}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {t("chat.externalImage.notLoaded")}: {option.label} —{" "}
                      {t("chat.externalImage.open")}
                    </a>
                  )}
                </>
              );
            }}
          </For>
        </div>
      )}
    </>
  );
}

type FreeTextControlProps = QuestionFreeTextProps & {
  class: string;
  placeholder: string;
  label?: string;
  id?: string;
};

function FreeTextTextarea(props: FreeTextControlProps) {
  let textarea!: HTMLTextAreaElement;
  let getTranscriptElement: QuestionFreeTextProps["getTranscriptElement"];
  const value = createMemo(() => props.value);
  onSettled(() => {
    getTranscriptElement = props.getTranscriptElement;
    observeTextareaOverflow(textarea, () => getTranscriptElement?.() ?? null);
    adjustTextareaHeight(textarea);
    return () => disconnectTextareaOverflowObserver(textarea);
  });
  // Keep the native textarea's measured height in sync with its committed answer.
  createEffect(
    () => ({ value: value(), getTranscriptElement: props.getTranscriptElement }),
    (next) => {
      getTranscriptElement = next.getTranscriptElement;
      adjustTextareaHeight(textarea);
    },
    { defer: true },
  );
  return (
    <textarea
      ref={(element) => {
        textarea = element;
        props.inputRef?.(element);
      }}
      id={props.id}
      class={[props.class, "chat-question-panel__textarea"]}
      rows={1}
      placeholder={props.placeholder}
      aria-label={props.label}
      aria-description={t("chat.questions.multilineHint", { shortcut: "Ctrl/⌘+Enter" })}
      value={value()}
      disabled={props.disabled}
      onInput={(event) => {
        handleTextareaOverflowInteraction(event);
        props.onInput(event.currentTarget.value);
      }}
      onBeforeInput={handleTextareaOverflowInteraction}
      onCompositionStart={handleTextareaOverflowInteraction}
      onKeyDown={handleTextareaOverflowInteraction}
      onBlur={handleTextareaOverflowInteraction}
      onWheel={handleTextareaOverflowInteraction}
      onPointerDown={handleTextareaOverflowInteraction}
      onScroll={handleTextareaOverflowScroll}
    />
  );
}

function FreeTextControl(props: FreeTextControlProps) {
  const questionId = createMemo(() => props.question.questionId);
  // Revealing applies only to this question; a new question starts masked.
  const [revealed, setRevealed] = createSignal(() => {
    questionId();
    return false;
  });
  return (
    <>
      {props.question.isSecret ? (
        <span class="chat-question-panel__secret">
          <input
            ref={(element) => props.inputRef?.(element)}
            id={props.id}
            class={props.class}
            type={revealed() ? "text" : "password"}
            autocomplete="off"
            spellcheck="false"
            placeholder={props.placeholder}
            aria-label={props.label}
            value={props.value}
            disabled={props.disabled}
            onInput={(event) => props.onInput(event.currentTarget.value)}
          />
          <button
            class="chat-question-panel__secret-toggle"
            type="button"
            aria-label={t(revealed() ? "chat.questions.hideSecret" : "chat.questions.showSecret")}
            aria-pressed={revealed() ? "true" : "false"}
            disabled={props.disabled}
            onClick={() => setRevealed((value) => !value)}
          >
            <Icon name={revealed() ? "eyeOff" : "eye"} />
          </button>
        </span>
      ) : (
        <FreeTextTextarea {...props} />
      )}
    </>
  );
}

export function QuestionFreeText(props: QuestionFreeTextProps) {
  const inputId = createUniqueId();
  const answerLabel = () => props.question.header || t("chat.questions.answer");
  return (
    <>
      {!props.question.resource &&
        (props.question.options.length === 0 || props.question.isOther) && (
          <>
            {props.question.options.length === 0 ? (
              <div class="field">
                <label for={inputId}>
                  <span>{answerLabel()}</span>
                </label>
                <FreeTextControl
                  {...props}
                  id={inputId}
                  class="input"
                  placeholder={t("chat.questions.answerPlaceholder", {
                    label: props.question.secretStore?.name ?? answerLabel(),
                  })}
                />
              </div>
            ) : (
              <div
                class={[
                  "chat-question-panel__option chat-question-panel__option--other",
                  { "chat-question-panel__option--selected": props.selected },
                ]}
              >
                <span class="chat-question-panel__option-marker" aria-hidden="true" />
                <FreeTextControl
                  {...props}
                  class="chat-question-panel__other"
                  placeholder={t("chat.questions.other")}
                  label={t("chat.questions.ownAnswerFor", { header: props.question.header })}
                />
                {props.question.options.length < 9 && (
                  <Shortcut value={props.question.options.length + 1} />
                )}
              </div>
            )}
          </>
        )}
    </>
  );
}
