import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../../lib/external-link.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
} from "./chat-composer-dom.ts";
import {
  initializeQuestionDrafts,
  questionDraftValues,
  questionPreservesWhitespace,
  renderQuestionFreeText,
  renderQuestionOptions,
} from "./chat-question-answer-controls.ts";
import "./chat-question-resource.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";

type QuestionPanelViewModel = QuestionPanelProps["model"];
type QuestionPanelQuestion = QuestionPanelViewModel["questions"][number];

export class ChatQuestionPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) props?: QuestionPanelProps;
  @state() private currentQuestionIndex = 0;
  @state() private pendingAction: { kind: "submit" | "skip" } | null = null;
  private requestKey: string | null = null;
  private collapsed = false;
  private focusAfterUpdate = false;
  private answerTextarea: HTMLTextAreaElement | null = null;
  private measuredAnswer: string | null = null;

  private setCollapsed(collapsed: boolean): void {
    if (this.props?.onCollapsedChange) {
      this.props.onCollapsedChange(collapsed);
      return;
    }
    this.collapsed = collapsed;
    this.focusAfterUpdate = !collapsed;
    this.requestUpdate();
  }

  override willUpdate() {
    const model = this.props?.model;
    const nextRequestKey = model?.requestKey ?? null;
    const nextCollapsed = model?.collapsed ?? false;
    if (nextRequestKey !== this.requestKey) {
      this.requestKey = nextRequestKey;
      if (model) {
        initializeQuestionDrafts(model.questions, model.drafts);
      }
      this.currentQuestionIndex = 0;
      this.pendingAction = null;
      this.collapsed = nextCollapsed;
      this.focusAfterUpdate = !nextCollapsed && model?.autoFocus !== false;
    } else if (this.props?.onCollapsedChange) {
      if (this.collapsed && !nextCollapsed) {
        this.focusAfterUpdate = true;
      }
      this.collapsed = nextCollapsed;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.answerTextarea) {
      disconnectTextareaOverflowObserver(this.answerTextarea);
      this.answerTextarea = null;
    }
  }

  override updated(): void {
    const textarea = this.querySelector<HTMLTextAreaElement>(".chat-question-panel__textarea");
    if (this.answerTextarea !== textarea) {
      if (this.answerTextarea) {
        disconnectTextareaOverflowObserver(this.answerTextarea);
      }
      this.answerTextarea = textarea;
      this.measuredAnswer = null;
      if (textarea) {
        observeTextareaOverflow(textarea);
      }
    }
    if (textarea && this.measuredAnswer !== textarea.value) {
      adjustTextareaHeight(textarea);
      this.measuredAnswer = textarea.value;
    }
    if (!this.focusAfterUpdate || this.collapsed) {
      return;
    }
    this.focusAfterUpdate = false;
    this.querySelector<HTMLElement>(".chat-question-panel")?.focus({ preventScroll: true });
  }

  private answerValues(model: QuestionPanelViewModel, question: QuestionPanelQuestion): string[] {
    return questionDraftValues(model.drafts.get(question.questionId), question);
  }

  private buildAnswers(model: QuestionPanelViewModel): Record<string, string[]> {
    return Object.fromEntries(
      model.questions.map((question) => [question.questionId, this.answerValues(model, question)]),
    );
  }

  private updateDraft(
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    draft: QuestionDraft,
  ): void {
    model.drafts.set(question.questionId, draft);
    this.requestUpdate();
    this.props?.onChange?.();
  }

  private focusPanel(): void {
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(".chat-question-panel")?.focus({ preventScroll: true }),
    );
  }

  private toggleOption(
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    value: string,
    advance = true,
  ): void {
    const draft = model.drafts.get(question.questionId);
    const selected = new Set(question.multiSelect ? draft?.selected : []);
    if (question.multiSelect && selected.has(value)) {
      selected.delete(value);
    } else {
      selected.add(value);
    }
    this.updateDraft(model, question, {
      selected,
      freeText: question.multiSelect ? (draft?.freeText ?? "") : "",
    });
    if (
      advance &&
      !question.multiSelect &&
      this.currentQuestionIndex < model.questions.length - 1
    ) {
      this.currentQuestionIndex += 1;
      this.focusPanel();
    }
  }

  private setFreeText(
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    value: string,
  ): void {
    const draft = model.drafts.get(question.questionId);
    this.updateDraft(model, question, {
      selected:
        !question.multiSelect && (questionPreservesWhitespace(question) ? value : value.trim())
          ? new Set()
          : (draft?.selected ?? new Set()),
      freeText: value,
    });
  }

  private async resolve(model: QuestionPanelViewModel, kind: "submit" | "skip"): Promise<void> {
    if (model.disabled || model.submitting || this.pendingAction) {
      return;
    }
    let run: () => void | Promise<void>;
    if (kind === "submit") {
      const onSubmit = this.props?.onSubmit;
      if (
        !onSubmit ||
        !model.questions.every(
          (question) => question.allowEmpty || this.answerValues(model, question).length > 0,
        )
      ) {
        return;
      }
      run = () => onSubmit(this.buildAnswers(model));
    } else {
      const onSkip = this.props?.onSkip;
      if (!onSkip) {
        return;
      }
      run = onSkip;
    }
    const action = { kind };
    this.pendingAction = action;
    try {
      await run();
    } catch {
      // The caller owns the error shown in model.error.
    } finally {
      if (this.pendingAction === action) {
        this.pendingAction = null;
      }
    }
  }

  private advanceOrSubmit(model: QuestionPanelViewModel, question: QuestionPanelQuestion): void {
    if (!question.allowEmpty && this.answerValues(model, question).length === 0) {
      return;
    }
    if (this.currentQuestionIndex < model.questions.length - 1) {
      this.currentQuestionIndex += 1;
      this.focusPanel();
      return;
    }
    void this.resolve(model, "submit");
  }

  private goBack(): void {
    if (this.currentQuestionIndex === 0) {
      return;
    }
    this.currentQuestionIndex -= 1;
    this.focusPanel();
  }

  private handleKeyDown(
    event: KeyboardEvent,
    model: QuestionPanelViewModel,
    question: QuestionPanelQuestion,
    disabled: boolean,
  ): void {
    if (disabled || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.target instanceof HTMLTextAreaElement) {
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (question.allowEmpty || this.answerValues(model, question).length > 0)
      ) {
        event.preventDefault();
        this.advanceOrSubmit(model, question);
      }
      // Text editing, including Enter and numeric keys, belongs to the textarea.
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    // Activating an external step must never also submit the pending question.
    if (event.target instanceof HTMLAnchorElement) {
      return;
    }
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      if (question.allowEmpty || this.answerValues(model, question).length > 0) {
        event.preventDefault();
        this.advanceOrSubmit(model, question);
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
      const currentIndex = Number(event.target.dataset.optionIndex ?? "0");
      const lastIndex = question.options.length - 1;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? lastIndex
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? (currentIndex - 1 + question.options.length) % question.options.length
              : (currentIndex + 1) % question.options.length;
      const nextOption = question.options[nextIndex];
      if (!nextOption) {
        return;
      }
      // Arrow navigation follows radio-group focus without leaving the step.
      // Explicit activation and numeric shortcuts keep the product's auto-advance behavior.
      this.toggleOption(model, question, nextOption.value ?? nextOption.label, false);
      void this.updateComplete.then(() =>
        this.querySelector<HTMLButtonElement>(
          `.chat-question-panel__option[data-option-index="${nextIndex}"]`,
        )?.focus({ preventScroll: true }),
      );
      return;
    }
    const optionIndex = Number(event.key) - 1;
    const option = this.querySelector<HTMLButtonElement>(
      `.chat-question-panel__option[data-option-index="${optionIndex}"]`,
    );
    if (optionIndex >= 0 && optionIndex < 9 && option) {
      event.preventDefault();
      option.click();
      return;
    }
    if (
      question.options.length > 0 &&
      question.options.length < 9 &&
      !question.resource &&
      question.isOther &&
      optionIndex === question.options.length
    ) {
      event.preventDefault();
      this.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        ".chat-question-panel__other",
      )?.focus({
        preventScroll: true,
      });
    }
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const { model } = props;
    const question = model.questions[this.currentQuestionIndex];
    if (!question) {
      return nothing;
    }
    const disabled = model.disabled || model.submitting || this.pendingAction !== null;
    const isLast = this.currentQuestionIndex === model.questions.length - 1;
    const canAdvance = question.allowEmpty || this.answerValues(model, question).length > 0;
    const draft = model.drafts.get(question.questionId);
    const progress = `${this.currentQuestionIndex + 1}/${model.questions.length}`;
    const requestProgress = model.requestPosition
      ? `${model.requestPosition.current}/${model.requestPosition.total}`
      : null;
    const requestNavigation = requestProgress
      ? html`<div class="chat-question-panel__request-nav">
          <button
            type="button"
            aria-label=${t("common.previous")}
            @click=${props.onPreviousRequest}
          >
            ${icons.chevronLeft}
          </button>
          <span>${requestProgress}</span>
          <button type="button" aria-label=${t("common.next")} @click=${props.onNextRequest}>
            ${icons.chevronRight}
          </button>
        </div>`
      : nothing;

    if (this.collapsed) {
      return html`
        <section
          class="chat-question-panel chat-question-panel--collapsed"
          aria-label=${model.title}
        >
          <button
            class="chat-question-panel__collapsed-button"
            type="button"
            @click=${() => this.setCollapsed(false)}
            aria-label=${t("chat.questions.expand")}
            aria-expanded="false"
          >
            <span
              ><strong>${model.title}</strong> ·
              ${model.collapsedLabel ? html`${model.collapsedLabel} · ${question.question}` : question.header}</span
            >
            ${model.collapsedLabel ? nothing : html`<span class="chat-question-panel__progress">${progress}</span>`}
            <span class="chat-question-panel__chevron">${icons.chevronDown}</span>
          </button>
          ${requestNavigation}
        </section>
      `;
    }

    return html`
      <section
        class="chat-question-panel"
        role="group"
        aria-label=${model.title}
        tabindex="0"
        @keydown=${(event: KeyboardEvent) => this.handleKeyDown(event, model, question, disabled)}
      >
        <div class="chat-question-panel__topline">
          <div class="chat-question-panel__title">${model.title}</div>
          ${requestNavigation}
          <span class="chat-question-panel__progress">${progress}</span>
          <button
            class="chat-question-panel__collapse"
            type="button"
            @click=${() => this.setCollapsed(true)}
            aria-label=${t("chat.questions.collapse")}
            aria-expanded="true"
          >
            ${icons.chevronDown}
          </button>
        </div>

        <div class="chat-question-panel__heading">
          <span class="chat-question-panel__prompt">${question.question}</span>
        </div>

        ${
          question.url
            ? html`<div class="chat-question-panel__external">
                <a
                  class="btn btn--sm"
                  href=${question.url}
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                >
                  ${icons.externalLink} ${t("chat.questions.openLink")}
                </a>
                <span class="muted">${t("chat.questions.externalStepHint")}</span>
              </div>`
            : nothing
        }
        ${renderQuestionOptions({
          question,
          selected: draft?.selected ?? new Set(),
          disabled,
          onSelect: (value) => this.toggleOption(model, question, value),
        })}
        ${
          question.secretStore
            ? html`
                <div class="chat-question-panel__store">
                  <div class="chat-question-panel__store-requester">
                    ${t("chat.questions.storeRequestedBy", {
                      agent: model.agentId ?? t("common.unknown"),
                      session: model.sessionKey ?? t("common.unknown"),
                    })}
                  </div>
                  <div class="chat-question-panel__store-entry">
                    ${t("chat.questions.storeEntry", {
                      name: question.secretStore.name,
                      kind:
                        question.secretStore.kind === "secret"
                          ? t("secretsStore.protectedSecret")
                          : t("secretsStore.agentReadable"),
                    })}
                  </div>
                  ${
                    question.secretStore.reason
                      ? html`<div class="chat-question-panel__store-reason">
                          ${question.secretStore.reason}
                        </div>`
                      : nothing
                  }
                  ${
                    question.secretStoreExisting
                      ? html`<div class="chat-question-panel__store-replacement">
                          ${
                            question.secretStoreExisting.updatedBy
                              ? t("chat.questions.storeReplacementBy", {
                                  name: question.secretStore.name,
                                  updated: formatRelativeTimestamp(
                                    question.secretStoreExisting.updatedAtMs,
                                  ),
                                  updatedBy: question.secretStoreExisting.updatedBy,
                                })
                              : t("chat.questions.storeReplacement", {
                                  name: question.secretStore.name,
                                  updated: formatRelativeTimestamp(
                                    question.secretStoreExisting.updatedAtMs,
                                  ),
                                })
                          }
                        </div>`
                      : nothing
                  }
                  ${
                    question.secretStore.kind === "secret"
                      ? html`<label class="chat-question-panel__store-hosts">
                          <span>${t("secretsStore.allowedHosts")}</span>
                          <input
                            class="chat-question-panel__other chat-question-panel__hosts"
                            type="text"
                            autocomplete="off"
                            placeholder=${t("secretsStore.allowedHostsPlaceholder")}
                            .value=${
                              model.secretStoreAllowedHostsDraft ??
                              question.secretStore.allowedHosts?.join(", ") ??
                              ""
                            }
                            ?disabled=${disabled}
                            @input=${(event: Event) => {
                              const target = event.target;
                              if (target instanceof HTMLInputElement) {
                                props.onSecretStoreAllowedHostsChange?.(target.value);
                              }
                            }}
                          />
                        </label>`
                      : nothing
                  }
                </div>
              `
            : nothing
        }
        ${renderQuestionFreeText({
          question,
          value: draft?.freeText ?? "",
          selected: Boolean(
            questionPreservesWhitespace(question) ? draft?.freeText : draft?.freeText.trim(),
          ),
          disabled,
          onInput: (value) => this.setFreeText(model, question, value),
        })}
        ${
          question.resource
            ? html`<openclaw-chat-question-resource
                .question=${question}
                .requestId=${model.requestKey}
                .sessionKey=${model.sessionKey ?? ""}
                .agentId=${model.agentId}
                .selected=${draft?.selected ?? new Set<string>()}
                .disabled=${disabled}
                @resource-selection=${(event: CustomEvent<{ values: string[] }>) => this.updateDraft(model, question, { selected: new Set(event.detail.values), freeText: "" })}
              ></openclaw-chat-question-resource>`
            : nothing
        }

        <div class="chat-question-panel__footer">
          ${model.notice ? html`<span class="chat-question-panel__error" role="status">${model.notice}</span>` : nothing}
          ${
            model.error
              ? html`<span class="chat-question-panel__error" role="status">
                  ${t("chat.questions.submitFailed", { error: model.error })}
                  ${
                    props.onDismissError
                      ? html`<button
                          type="button"
                          class="chat-question-panel__error-dismiss"
                          aria-label=${t("chat.actions.dismissError")}
                          @click=${props.onDismissError}
                        >
                          ${icons.x}
                        </button>`
                      : nothing
                  }
                </span>`
              : nothing
          }
          ${
            this.currentQuestionIndex > 0
              ? html`<button
                  class="btn btn--sm chat-question-panel__back"
                  type="button"
                  ?disabled=${disabled}
                  @click=${() => this.goBack()}
                >
                  ${t("chat.questions.back")}
                </button>`
              : nothing
          }
          ${
            props.onSkip
              ? html`<button
                  class="btn btn--sm chat-question-panel__skip"
                  type="button"
                  ?disabled=${disabled}
                  @click=${() => void this.resolve(model, "skip")}
                >
                  ${
                    this.pendingAction?.kind === "skip"
                      ? t(
                          model.nonBlocking
                            ? "chat.asyncQuestions.dismissing"
                            : "chat.questions.skipping",
                        )
                      : t(model.nonBlocking ? "chat.asyncQuestions.dismiss" : "chat.questions.skip")
                  }
                </button>`
              : nothing
          }
          <button
            class="btn btn--sm primary chat-question-panel__advance"
            type="button"
            ?disabled=${disabled || !canAdvance || !props.onSubmit}
            @click=${() => this.advanceOrSubmit(model, question)}
          >
            ${
              this.pendingAction?.kind === "submit" || model.submitting
                ? t("chat.questions.submitting")
                : isLast
                  ? t("chat.questions.submit")
                  : t("chat.questions.next")
            }
          </button>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-chat-question-panel")) {
  customElements.define("openclaw-chat-question-panel", ChatQuestionPanel);
}
