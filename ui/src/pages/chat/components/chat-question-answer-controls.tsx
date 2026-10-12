import type { Question } from "@openclaw/gateway-protocol";
import { For } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";

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

function Shortcut(props: { value: number }) {
  return (
    <kbd class="shortcut-kbd">
      <span class="kbd__text">{props.value}</span>
    </kbd>
  );
}

export function QuestionOptions(props: QuestionOptionsProps) {
  const implicit = () => props.question.resource?.selection === "implicit";
  const options = () =>
    props.question.options.filter(
      (option) => !implicit() || props.selected.has(option.value ?? option.label),
    );
  const hasThumbnails = () => options().some((option) => option.thumbnail);
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
              return (
                <>
                  <button
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

function FreeTextControl(
  props: QuestionFreeTextProps & { class: string; placeholder: string; label?: string },
) {
  const handleInput = (
    event: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement },
  ) => props.onInput(event.currentTarget.value);
  return (
    <>
      {props.question.isSecret ? (
        <input
          class={props.class}
          type="password"
          autocomplete="off"
          placeholder={props.placeholder}
          aria-label={props.label}
          value={props.value}
          disabled={props.disabled}
          onInput={handleInput}
        />
      ) : (
        <textarea
          class={`${props.class} chat-question-panel__textarea`}
          rows={1}
          placeholder={props.placeholder}
          aria-label={props.label}
          aria-description={t("chat.questions.multilineHint", { shortcut: "Ctrl/⌘+Enter" })}
          value={props.value}
          disabled={props.disabled}
          onInput={handleInput}
        />
      )}
    </>
  );
}

export function QuestionFreeText(props: QuestionFreeTextProps) {
  const answerLabel = () => props.question.header || t("chat.questions.answer");
  return (
    <>
      {!props.question.resource &&
        (props.question.options.length === 0 || props.question.isOther) && (
          <>
            {props.question.options.length === 0 ? (
              <label class="field">
                <span>{answerLabel()}</span>
                <FreeTextControl
                  {...props}
                  class="input"
                  placeholder={t("chat.questions.answerPlaceholder", {
                    label: props.question.secretStore?.name ?? answerLabel(),
                  })}
                />
              </label>
            ) : (
              <label
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
              </label>
            )}
          </>
        )}
    </>
  );
}
