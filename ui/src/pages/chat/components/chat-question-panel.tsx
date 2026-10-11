import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../../lib/external-link.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
} from "./chat-composer-dom.ts";
import {
  initializeQuestionDrafts,
  questionDraftValues,
  questionPreservesWhitespace,
} from "./chat-question-answer-controls.ts";
import { QuestionFreeText, QuestionOptions } from "./chat-question-answer-controls.tsx";
import { ChatQuestionResource } from "./chat-question-resource.tsx";
import type {
  QuestionPanelProps,
  QuestionPanelQuestion,
  QuestionPanelViewModel,
} from "./chat-question-types.ts";

type PanelBridgeProps = { props?: QuestionPanelProps };
export type ChatQuestionPanel = SolidBridgeElement<PanelBridgeProps>;

function QuestionPanelRequest(props: { panel: QuestionPanelProps; host: ChatQuestionPanel }) {
  const initialModel = untrack(() => props.panel.model);
  const host = untrack(() => props.host);
  initializeQuestionDrafts(initialModel.questions, initialModel.drafts);
  const [currentQuestionIndex, setCurrentQuestionIndex] = createSignal(0);
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = createSignal(initialModel.collapsed);
  const [draftRevision, setDraftRevision] = createSignal(0);
  const [actionRevision, setActionRevision] = createSignal(0);
  let pendingAction: { kind: "submit" | "skip" } | null = null;
  const pendingKind = () => {
    actionRevision();
    return pendingAction?.kind ?? null;
  };
  let live = true;
  let answerTextarea: HTMLTextAreaElement | null = null;
  let measuredAnswer: string | null = null;
  const model = () => props.panel.model;
  const collapsed = () =>
    props.panel.onCollapsedChange ? model().collapsed : uncontrolledCollapsed();
  const question = () => model().questions[currentQuestionIndex()];
  const draft = () => {
    draftRevision();
    return model().drafts.get(question()?.questionId ?? "");
  };
  const disabled = () => model().disabled || model().submitting || pendingKind() !== null;
  const answerValues = (value: QuestionPanelViewModel, item: QuestionPanelQuestion) =>
    questionDraftValues(value.drafts.get(item.questionId), item);
  const canAdvance = () => {
    draftRevision();
    const item = question();
    return item && (item.allowEmpty || answerValues(model(), item).length > 0);
  };
  const focusPanel = () =>
    host.querySelector<HTMLElement>(".chat-question-panel")?.focus({ preventScroll: true });
  const focusTarget = createMemo(() => [collapsed(), currentQuestionIndex()] as const, {
    equals: (previous, next) => previous[0] === next[0] && previous[1] === next[1],
  });
  let initialFocus = true;
  createEffect(focusTarget, ([isCollapsed]) => {
    if (!isCollapsed && (!initialFocus || initialModel.autoFocus !== false)) {
      focusPanel();
    }
    initialFocus = false;
  });
  createEffect(
    () => [draft(), currentQuestionIndex(), collapsed()] as const,
    () => {
      const textarea = host.querySelector<HTMLTextAreaElement>(".chat-question-panel__textarea");
      if (answerTextarea !== textarea) {
        if (answerTextarea) {
          disconnectTextareaOverflowObserver(answerTextarea);
        }
        answerTextarea = textarea;
        measuredAnswer = null;
        if (textarea) {
          observeTextareaOverflow(textarea);
        }
      }
      if (textarea && measuredAnswer !== textarea.value) {
        adjustTextareaHeight(textarea);
        measuredAnswer = textarea.value;
      }
    },
  );
  onCleanup(() => {
    live = false;
    if (answerTextarea) {
      disconnectTextareaOverflowObserver(answerTextarea);
    }
  });
  const setCollapsed = (value: boolean) => {
    if (props.panel.onCollapsedChange) {
      props.panel.onCollapsedChange(value);
    } else {
      setUncontrolledCollapsed(value);
    }
  };
  const updateDraft = (item: QuestionPanelQuestion, value: QuestionDraft) => {
    model().drafts.set(item.questionId, value);
    setDraftRevision((revision) => revision + 1);
    props.panel.onChange?.();
  };
  const toggleOption = (item: QuestionPanelQuestion, value: string, advance = true) => {
    const previous = model().drafts.get(item.questionId);
    const selected = new Set(item.multiSelect ? previous?.selected : []);
    if (item.multiSelect && selected.has(value)) {
      selected.delete(value);
    } else {
      selected.add(value);
    }
    updateDraft(item, { selected, freeText: item.multiSelect ? (previous?.freeText ?? "") : "" });
    if (advance && !item.multiSelect && currentQuestionIndex() < model().questions.length - 1) {
      setCurrentQuestionIndex((index) => index + 1);
    }
  };
  const setFreeText = (item: QuestionPanelQuestion, value: string) => {
    const previous = model().drafts.get(item.questionId);
    updateDraft(item, {
      selected:
        !item.multiSelect && (questionPreservesWhitespace(item) ? value : value.trim())
          ? new Set()
          : (previous?.selected ?? new Set()),
      freeText: value,
    });
  };
  const resolve = async (kind: "submit" | "skip") => {
    const value = model();
    if (value.disabled || value.submitting || pendingAction) {
      return;
    }
    let run: () => void | Promise<void>;
    if (kind === "submit") {
      const onSubmit = props.panel.onSubmit;
      if (
        !onSubmit ||
        !value.questions.every((item) => item.allowEmpty || answerValues(value, item).length > 0)
      ) {
        return;
      }
      const answers = Object.fromEntries(
        value.questions.map((item) => [item.questionId, answerValues(value, item)]),
      );
      run = () => onSubmit(answers);
    } else {
      const onSkip = props.panel.onSkip;
      if (!onSkip) {
        return;
      }
      run = onSkip;
    }
    const action = { kind };
    pendingAction = action;
    setActionRevision((revision) => revision + 1);
    try {
      await run();
    } catch {
      /* The caller owns the error shown in model.error. */
    } finally {
      if (live && pendingAction === action) {
        pendingAction = null;
        setActionRevision((revision) => revision + 1);
      }
    }
  };
  const advanceOrSubmit = (item: QuestionPanelQuestion) => {
    if (!item.allowEmpty && answerValues(model(), item).length === 0) {
      return;
    }
    if (currentQuestionIndex() < model().questions.length - 1) {
      setCurrentQuestionIndex((index) => index + 1);
    } else {
      void resolve("submit");
    }
  };
  const handleKeyDown = (event: KeyboardEvent, item: QuestionPanelQuestion) => {
    if (disabled() || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.target instanceof HTMLTextAreaElement) {
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (item.allowEmpty || answerValues(model(), item).length > 0)
      ) {
        event.preventDefault();
        advanceOrSubmit(item);
      }
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.target instanceof HTMLAnchorElement
    ) {
      return;
    }
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      if (item.allowEmpty || answerValues(model(), item).length > 0) {
        event.preventDefault();
        advanceOrSubmit(item);
      }
      return;
    }
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    if (
      event.target instanceof HTMLButtonElement &&
      event.target.getAttribute("role") === "radio" &&
      ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)
    ) {
      event.preventDefault();
      const index = Number(event.target.dataset.optionIndex ?? "0");
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? item.options.length - 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? (index - 1 + item.options.length) % item.options.length
              : (index + 1) % item.options.length;
      const option = item.options[next];
      if (!option) {
        return;
      }
      toggleOption(item, option.value ?? option.label, false);
      // The same option node survives selection; focus need not wait for rendering.
      props.host
        .querySelector<HTMLButtonElement>(
          `.chat-question-panel__option[data-option-index="${next}"]`,
        )
        ?.focus({ preventScroll: true });
      return;
    }
    const index = Number(event.key) - 1;
    const option = host.querySelector<HTMLButtonElement>(
      `.chat-question-panel__option[data-option-index="${index}"]`,
    );
    if (index >= 0 && index < 9 && option) {
      event.preventDefault();
      option.click();
      return;
    }
    if (
      item.options.length > 0 &&
      item.options.length < 9 &&
      !item.resource &&
      item.isOther &&
      index === item.options.length
    ) {
      event.preventDefault();
      props.host
        .querySelector<HTMLInputElement | HTMLTextAreaElement>(".chat-question-panel__other")
        ?.focus({ preventScroll: true });
    }
  };
  const requestNavigation = () =>
    model().requestPosition && (
      <div class="chat-question-panel__request-nav">
        <button
          type="button"
          aria-label={t("common.previous")}
          onClick={() => props.panel.onPreviousRequest?.()}
        >
          <Icon name="chevronLeft" />
        </button>
        <span>
          {model().requestPosition!.current}/{model().requestPosition!.total}
        </span>
        <button
          type="button"
          aria-label={t("common.next")}
          onClick={() => props.panel.onNextRequest?.()}
        >
          <Icon name="chevronRight" />
        </button>
      </div>
    );
  const Action = (action: {
    name: "back" | "skip" | "advance";
    label: string;
    onClick: () => void;
    unavailable?: boolean;
  }) => (
    <button
      class={[
        "btn btn--sm",
        `chat-question-panel__${action.name}`,
        { primary: action.name === "advance" },
      ]}
      type="button"
      disabled={disabled() || action.unavailable}
      onClick={() => action.onClick()}
    >
      {action.label}
    </button>
  );
  const progress = () => `${currentQuestionIndex() + 1}/${model().questions.length}`;
  return (
    <Show when={question()}>
      {(item) => (
        <>
          {collapsed() ? (
            <section
              class="chat-question-panel chat-question-panel--collapsed"
              aria-label={model().title}
            >
              <button
                class="chat-question-panel__collapsed-button"
                type="button"
                onClick={() => setCollapsed(false)}
                aria-label={t("chat.questions.expand")}
                aria-expanded="false"
              >
                <span>
                  {!model().nonBlocking && (
                    <>
                      <strong>{model().title}</strong> ·{" "}
                    </>
                  )}
                  {model().collapsedLabel
                    ? `${model().collapsedLabel} · ${item().question}`
                    : item().header}
                </span>
                {!model().collapsedLabel && (
                  <span class="chat-question-panel__progress">{progress()}</span>
                )}
                <span class="chat-question-panel__chevron">
                  <Icon name="chevronDown" />
                </span>
              </button>
              {requestNavigation()}
            </section>
          ) : (
            <section
              class="chat-question-panel"
              role="group"
              aria-label={model().title}
              tabindex={0}
              onKeyDown={(event) => handleKeyDown(event, item())}
            >
              <div
                class={[
                  "chat-question-panel__topline",
                  { "chat-question-panel__topline--prompt": model().nonBlocking },
                ]}
              >
                {model().nonBlocking ? (
                  <span class="chat-question-panel__prompt">{item().question}</span>
                ) : (
                  <div class="chat-question-panel__title">{model().title}</div>
                )}
                {requestNavigation()}
                <span class="chat-question-panel__progress">{progress()}</span>
                <button
                  class="chat-question-panel__collapse"
                  type="button"
                  onClick={() => setCollapsed(true)}
                  aria-label={t("chat.questions.collapse")}
                  aria-expanded="true"
                >
                  <Icon name="chevronDown" />
                </button>
              </div>
              {!model().nonBlocking && (
                <div class="chat-question-panel__heading">
                  <span class="chat-question-panel__prompt">{item().question}</span>
                </div>
              )}
              {item().url && (
                <div class="chat-question-panel__external">
                  <a
                    class="btn btn--sm"
                    href={item().url}
                    target={EXTERNAL_LINK_TARGET}
                    rel={buildExternalLinkRel()}
                  >
                    <Icon name="externalLink" /> {t("chat.questions.openLink")}
                  </a>
                  <span class="muted">{t("chat.questions.externalStepHint")}</span>
                </div>
              )}
              <QuestionOptions
                question={item()}
                selected={draft()?.selected ?? new Set()}
                disabled={disabled()}
                onSelect={(value) => toggleOption(item(), value)}
              />
              {item().secretStore && (
                <div class="chat-question-panel__store">
                  <div class="chat-question-panel__store-requester">
                    {t("chat.questions.storeRequestedBy", {
                      agent: model().agentId ?? t("common.unknown"),
                      session: model().sessionKey ?? t("common.unknown"),
                    })}
                  </div>
                  <div class="chat-question-panel__store-entry">
                    {t("chat.questions.storeEntry", {
                      name: item().secretStore!.name,
                      kind:
                        item().secretStore!.kind === "secret"
                          ? t("secretsStore.protectedSecret")
                          : t("secretsStore.agentReadable"),
                    })}
                  </div>
                  {item().secretStore!.reason && (
                    <div class="chat-question-panel__store-reason">
                      {item().secretStore!.reason}
                    </div>
                  )}
                  {item().secretStoreExisting && (
                    <div class="chat-question-panel__store-replacement">
                      {item().secretStoreExisting!.updatedBy
                        ? t("chat.questions.storeReplacementBy", {
                            name: item().secretStore!.name,
                            updated: formatRelativeTimestamp(
                              item().secretStoreExisting!.updatedAtMs,
                            ),
                            updatedBy: item().secretStoreExisting!.updatedBy!,
                          })
                        : t("chat.questions.storeReplacement", {
                            name: item().secretStore!.name,
                            updated: formatRelativeTimestamp(
                              item().secretStoreExisting!.updatedAtMs,
                            ),
                          })}
                    </div>
                  )}
                  {item().secretStore!.kind === "secret" && (
                    <label class="chat-question-panel__store-hosts">
                      <span>{t("secretsStore.allowedHosts")}</span>
                      <input
                        class="chat-question-panel__other chat-question-panel__hosts"
                        type="text"
                        autocomplete="off"
                        placeholder={t("secretsStore.allowedHostsPlaceholder")}
                        value={
                          model().secretStoreAllowedHostsDraft ??
                          item().secretStore!.allowedHosts?.join(", ") ??
                          ""
                        }
                        disabled={disabled()}
                        onInput={(event) =>
                          props.panel.onSecretStoreAllowedHostsChange?.(event.currentTarget.value)
                        }
                      />
                    </label>
                  )}
                </div>
              )}
              <QuestionFreeText
                question={item()}
                value={draft()?.freeText ?? ""}
                selected={Boolean(
                  questionPreservesWhitespace(item())
                    ? draft()?.freeText
                    : draft()?.freeText.trim(),
                )}
                disabled={disabled()}
                onInput={(value) => setFreeText(item(), value)}
              />
              {item().resource && (
                <ChatQuestionResource
                  question={item()}
                  requestId={model().requestKey}
                  sessionKey={model().sessionKey ?? ""}
                  agentId={model().agentId}
                  selected={draft()?.selected ?? new Set()}
                  disabled={disabled()}
                  onResource-selection={(event: CustomEvent<{ values: string[] }>) =>
                    updateDraft(item(), { selected: new Set(event.detail.values), freeText: "" })
                  }
                />
              )}
              <div class="chat-question-panel__footer">
                {model().notice && (
                  <span class="chat-question-panel__error" role="status">
                    {model().notice}
                  </span>
                )}
                {model().error && (
                  <span class="chat-question-panel__error" role="status">
                    {t("chat.questions.submitFailed", { error: model().error! })}
                    {props.panel.onDismissError && (
                      <button
                        type="button"
                        class="chat-question-panel__error-dismiss"
                        aria-label={t("chat.actions.dismissError")}
                        onClick={() => props.panel.onDismissError?.()}
                      >
                        <Icon name="x" />
                      </button>
                    )}
                  </span>
                )}
                {currentQuestionIndex() > 0 && (
                  <Action
                    name="back"
                    label={t("chat.questions.back")}
                    onClick={() => setCurrentQuestionIndex((index) => index - 1)}
                  />
                )}
                {props.panel.onSkip && (
                  <Action
                    name="skip"
                    label={
                      pendingKind() === "skip"
                        ? t(
                            model().nonBlocking
                              ? "chat.asyncQuestions.dismissing"
                              : "chat.questions.skipping",
                          )
                        : t(
                            model().nonBlocking
                              ? "chat.asyncQuestions.dismiss"
                              : "chat.questions.skip",
                          )
                    }
                    onClick={() => void resolve("skip")}
                  />
                )}
                {
                  <Action
                    name="advance"
                    label={
                      pendingKind() === "submit" || model().submitting
                        ? t("chat.questions.submitting")
                        : currentQuestionIndex() === model().questions.length - 1
                          ? t("chat.questions.submit")
                          : t("chat.questions.next")
                    }
                    onClick={() => advanceOrSubmit(item())}
                    unavailable={!canAdvance() || !props.panel.onSubmit}
                  />
                }
              </div>
            </section>
          )}
        </>
      )}
    </Show>
  );
}

export const ChatQuestionPanel = defineSolidBridge<PanelBridgeProps>(
  "openclaw-chat-question-panel",
  (props, host) => {
    const request = createMemo(() => (props.props ? { key: props.props.model.requestKey } : null), {
      equals: (previous, next) => previous?.key === next?.key,
    });
    return (
      <Show when={request()} keyed>
        {(_request) => <QuestionPanelRequest panel={props.props!} host={host} />}
      </Show>
    );
  },
  { properties: { props: { default: undefined, attribute: false } } },
);
