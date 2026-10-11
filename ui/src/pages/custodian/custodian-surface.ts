import "../../styles/chat/startup-layout.css";
import { consume } from "@lit/context";
import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { SYSTEM_AGENT_ID } from "../../../../src/system-agent/agent-id.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { markdownBlocks } from "../../components/markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { handleMarkdownTableInteraction } from "../../components/markdown-tables.ts";
import { renderPanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import "../../components/option-card.tsx";
import "../../components/openclaw-mascot.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/chat/grouped.css";
import "../../styles/chat/layout.css";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-surface.css";
import "../../styles/chat/text.css";
import "../../styles/custodian.css";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
} from "../chat/components/chat-composer-dom.ts";
import { renderChatDivider } from "../chat/components/chat-divider.ts";
import { renderMessageGroup } from "../chat/components/chat-message.ts";
import { renderCustodianAlertCard } from "./custodian-alert-card.ts";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import * as eventNudgeState from "./event-nudge.ts";
import {
  createPluginHelpRequest,
  currentPluginHelpReference,
  pluginHelpFocusRequest,
} from "./plugin-help.ts";
import { sessionVariant } from "./session-lifecycle.ts";
import type { CustodianMessage } from "./transcript.ts";

registerPluginManagementEnglish();

function toCustodianMessageGroup(message: CustodianMessage): MessageGroup {
  const key = `msg-${message.id}`;
  const rawMessage = { role: message.role, content: message.text };
  const normalized = normalizeMessage(rawMessage);
  const visibleContent = resolveMessageVisibleContent(rawMessage, normalized);
  return {
    kind: "group",
    key,
    role: message.role,
    messages: [
      {
        message: rawMessage,
        key,
        hasVisibleContent:
          visibleContent === "non-text" ||
          Boolean(resolveMessageDisplayMarkdown(rawMessage, normalized).trim()),
      },
    ],
    visibleContent,
    timestamp: message.at,
    isStreaming: false,
  };
}

function renderCustodianTranscriptEntry(
  store: CustodianSessionStore,
  message: CustodianMessage,
  activeWizardMessage: CustodianMessage | undefined,
) {
  const question = message.question;
  const step = message.step;
  const questionKey = question ? `${message.id}:${question.id}` : "";
  return html`
    ${
      message.text
        ? renderMessageGroup(toCustodianMessageGroup(message), {
            showReasoning: false,
            showToolCalls: false,
            assistantName: t("custodian.title"),
            agentId: SYSTEM_AGENT_ID,
          })
        : nothing
    }
    ${
      message.id === store.earlierBoundaryAfterId
        ? renderChatDivider({
            kind: "divider",
            key: "custodian-earlier",
            label: t("custodian.earlier"),
            timestamp: message.at,
          })
        : nothing
    }
    ${
      question && !store.dismissedQuestions.has(questionKey)
        ? html`<div class="custodian__option-card">
            <openclaw-option-card
              .props=${{
                header: question.header,
                question: question.question,
                options: question.options.map((option) => ({
                  value: option.label,
                  label: option.label,
                  description: option.description,
                  recommended: option.recommended,
                })),
                disabled: !store.canSend || store.answeredQuestions.has(questionKey),
                onSelect: (label: string) => store.answerQuestion(message, label),
                onSkip: () => void store.dismissQuestion(message),
              }}
            ></openclaw-option-card>
          </div>`
        : nothing
    }
    ${
      message === activeWizardMessage && step
        ? html`<section
            class="custodian__wizard-step"
            aria-label=${formatUiExternalText(step.title ?? step.message, "Setup")}
          >
            ${
              step.title
                ? html`<strong class="custodian__wizard-title"
                    >${formatUiExternalText(step.title)}</strong
                  >`
                : nothing
            }
            ${renderWizardStepControls({
              step,
              value: store.wizardValue,
              busy: !store.canSend,
              inputId: `custodian-wizard-input-${message.id}`,
              sensitiveRevealed: store.wizardSecretVisible,
              onValueChange: (value) => store.setWizardValue(value),
              onAnswer: (value) => store.answerWizardStep(message, value),
              leadingAction: store.wizardCancelAvailable
                ? html`<button
                    class="btn btn--ghost custodian__wizard-cancel"
                    type="button"
                    ?disabled=${!store.canSend}
                    @click=${() => store.cancelWizardStep(message)}
                  >
                    ${t("custodian.cancel")}
                  </button>`
                : undefined,
              onToggleSensitiveVisibility: () => store.toggleWizardSecretVisibility(),
            })}
          </section>`
        : nothing
    }
  `;
}

class CustodianSurface extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) store: CustodianSessionStore = custodianSessionStore;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) newAgentIntent = false;
  @property({ attribute: false }) showChannelOnboardingNudge = false;
  @property({ attribute: false }) channelOnboardingError: string | null = null;
  @property({ attribute: false }) channelOnboardingRetrying = false;
  @property({ attribute: false }) onRetryChannelOnboarding: () => void = () => undefined;
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) historyContent: TemplateResult | typeof nothing = nothing;

  private composerTextarea: HTMLTextAreaElement | null = null;
  private lastMessageId: number | null = null;
  private lastPluginHelpFocus = 0;

  constructor() {
    super();
    void new SubscriptionsController(this)
      .watchStore(() => this.store)
      .watchStore(() => custodianAlertStore);
  }

  protected override async getUpdateComplete(): Promise<boolean> {
    const complete = await super.getUpdateComplete();
    await Promise.all(
      Array.from(
        this.querySelectorAll<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-option-card",
        ),
      ).map((card) => card.updateComplete),
    );
    return complete;
  }

  override willUpdate(): void {
    this.store.connect(this.context, sessionVariant(this.onboarding, this.newAgentIntent));
  }

  override disconnectedCallback(): void {
    if (this.composerTextarea) {
      disconnectTextareaOverflowObserver(this.composerTextarea);
      this.composerTextarea = null;
    }
    super.disconnectedCallback();
  }

  override updated(): void {
    const store = this.store;
    const textarea = this.querySelector<HTMLTextAreaElement>("textarea");
    if (this.composerTextarea && this.composerTextarea !== textarea) {
      disconnectTextareaOverflowObserver(this.composerTextarea);
    }
    this.composerTextarea = textarea;
    if (textarea) {
      observeTextareaOverflow(textarea);
      adjustTextareaHeight(textarea);
    }
    if (store.canSend && !store.sensitive && !store.hasUnresolvedQuestion()) {
      custodianAlertStore.askIfReady(
        (question, admission, display) => void store.send(question, display, false, admission),
      );
    }
    const focusRequest = pluginHelpFocusRequest(this.context);
    if (
      focusRequest > 0 &&
      focusRequest !== this.lastPluginHelpFocus &&
      !store.sensitive &&
      !store.wizardInputPending &&
      store.chatAvailable
    ) {
      this.lastPluginHelpFocus = focusRequest;
      textarea?.focus();
    }
    const transcript = this.querySelector<HTMLElement>(".custodian__messages");
    const messageId = this.store.messages.at(-1)?.id ?? null;
    if (messageId !== this.lastMessageId) {
      this.lastMessageId = messageId;
      const lastMessage = transcript?.lastElementChild;
      if (lastMessage instanceof HTMLElement) {
        lastMessage.scrollIntoView?.({ block: "nearest" });
      }
    }
  }

  private handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    void this.store.send();
  }

  override render() {
    const store = this.store;
    const plugin = currentPluginHelpReference(this.context);
    const placeholder = plugin
      ? t("custodian.pluginPlaceholder", { plugin: plugin.name })
      : t("custodian.placeholder");
    const alertCard = custodianAlertStore.alert
      ? renderCustodianAlertCard({
          alert: custodianAlertStore.alert,
          context: this.context,
          onDismiss: () => custodianAlertStore.dismiss(),
        })
      : nothing;
    if (store.setupRequired) {
      return html`
        <section
          class="custodian-surface custodian-surface--setup-required ${
            this.compact ? "custodian-surface--panel" : ""
          }"
        >
          ${alertCard}
          <div class="custodian__setup-state" role="alert">
            <openclaw-mascot mood="idle" .size=${this.compact ? 72 : 96}></openclaw-mascot>
            <h2>${t("modelSetup.required.title")}</h2>
            <p>${t("modelSetup.required.body")}</p>
            <div class="custodian__setup-actions">
              <button
                class="btn primary"
                type="button"
                @click=${() => store.exitSetup("model-setup")}
              >
                ${t("modelSetup.required.action")}
              </button>
            </div>
          </div>
        </section>
      `;
    }
    const emptyError = store.messages.length === 0 && store.error !== null && !store.sending;
    const activeWizardMessage = store.wizardInputPending
      ? store.messages.findLast((message) => message.step !== null)
      : undefined;
    // Greeting suggestions are optional; actual pending setup input and existing
    // conversations retain their transcript and the Gateway's inference gate.
    const pluginWelcome =
      plugin &&
      store.activeVariant === "caretaker" &&
      !store.sensitive &&
      !store.hasUnresolvedQuestion();
    const pluginIntro = pluginWelcome && !store.hasRealUserTurn();
    const askPlugin = pluginIntro ? createPluginHelpRequest(this.context, plugin) : undefined;
    return html`
      <section
        class="custodian-surface ${this.compact ? "custodian-surface--panel" : ""} ${
          emptyError ? "custodian-surface--empty-error" : ""
        }"
      >
        <div
          class="custodian__messages"
          ${markdownBlocks()}
          aria-live="polite"
          @click=${(event: MouseEvent) => {
            handleMarkdownCodeBlockClick(event);
            handleMarkdownTableInteraction(event);
          }}
        >
          ${alertCard}
          ${
            this.channelOnboardingError || this.showChannelOnboardingNudge
              ? eventNudgeState.renderCustodianChannelOnboardingNudge({
                  error: Boolean(this.channelOnboardingError),
                  retrying: this.channelOnboardingRetrying,
                  onAction: this.channelOnboardingError
                    ? this.onRetryChannelOnboarding
                    : () => store.openChannelsFromOnboarding(),
                  onDismiss: () => store.dismissChannelOnboardingNudge(),
                })
              : nothing
          }
          ${
            !this.onboarding && store.eventNudge && !store.eventNudgePending
              ? eventNudgeState.renderCustodianEventNudge({
                  nudge: store.eventNudge,
                  disabled: !store.canSend || store.sensitive || store.hasUnresolvedQuestion(),
                  onSend: () => void store.sendEventNudge(),
                  onDismiss: () => store.dismissEventNudge(),
                })
              : nothing
          }
          ${
            pluginIntro
              ? html`<div class="custodian__plugin-intro">
                  <h2>${t("custodian.pluginIntroTitle", { plugin: plugin.name })}</h2>
                  <div class="custodian__plugin-starters">
                    ${(
                      [
                        ["custodian.pluginStarterPurpose", "custodian.pluginPromptPurpose"],
                        ["custodian.pluginStarterTools", "custodian.pluginPromptTools"],
                        ["custodian.pluginStarterSetup", "custodian.pluginPromptSetup"],
                      ] as const
                    ).map(([labelKey, promptKey]) => {
                      const label = t(labelKey);
                      const prompt = t(promptKey, { plugin: plugin.name });
                      return html`<button
                        class="btn"
                        type="button"
                        @click=${() => void askPlugin?.({ question: prompt })}
                      >
                        ${label}
                      </button>`;
                    })}
                  </div>
                </div>`
              : nothing
          }
          ${store.messages
            .filter((message) => !pluginWelcome || !message.optionalWelcome)
            .map((message) => renderCustodianTranscriptEntry(store, message, activeWizardMessage))}
          ${
            store.sending
              ? html`<div class="chat-group assistant custodian__thinking-row" role="status">
                  <div class="chat-avatar assistant custodian__mascot-avatar" aria-hidden="true">
                    <openclaw-mascot mood="thinking" .size=${26}></openclaw-mascot>
                  </div>
                  <div class="chat-group-messages custodian__thinking">
                    <span></span><span></span><span></span>
                    <span class="sr-only">${t("custodian.thinking")}</span>
                  </div>
                </div>`
              : nothing
          }
          ${
            store.abandonedTurnOutcomeUnknown
              ? html`<div class="custodian__error" role="alert">
                  <span>${t("custodian.connectionChanged")}</span>
                </div>`
              : nothing
          }
          ${renderPanelRefreshStatus({
            status: store.transcript.status,
            className: "custodian__transcript-status",
          })}
          ${
            store.error &&
            !(store.abandonedTurnOutcomeUnknown && store.error === t("custodian.connectionChanged"))
              ? html`<div class="custodian__error" role="alert">
                  <span>${store.error}</span>
                  ${
                    store.activeClient && store.chatAvailable && store.canRetry()
                      ? html`<button
                          class="btn btn--sm"
                          type="button"
                          @click=${() => store.retry()}
                        >
                          ${t("common.retry")}
                        </button>`
                      : nothing
                  }
                </div>`
              : nothing
          }
        </div>

        ${this.historyContent}
        ${
          activeWizardMessage
            ? nothing
            : html`<div class="agent-chat__composer-shell">
                <div class="agent-chat__input">
                  <div class="agent-chat__composer-input-row">
                    <div class="agent-chat__composer-combobox">
                      ${
                        store.sensitive
                          ? html`<input
                              type="password"
                              .value=${store.input}
                              autocomplete="off"
                              placeholder=${t("custodian.sensitivePlaceholder")}
                              aria-label=${t("custodian.sensitivePlaceholder")}
                              ?disabled=${!store.canSend}
                              @input=${(event: Event) =>
                                store.setInput((event.target as HTMLInputElement).value)}
                              @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
                            />`
                          : html`<textarea
                              rows="1"
                              .value=${store.input}
                              autocomplete="on"
                              placeholder=${placeholder}
                              aria-label=${placeholder}
                              ?disabled=${!store.chatAvailable}
                              @input=${(event: Event) =>
                                store.setInput((event.target as HTMLTextAreaElement).value)}
                              @keydown=${(event: KeyboardEvent) => this.handleComposerKeydown(event)}
                            ></textarea>`
                      }
                      <span class="agent-chat__composer-placeholder" aria-hidden="true"
                        >${store.sensitive ? t("custodian.sensitivePlaceholder") : placeholder}</span
                      >
                    </div>
                    <div class="agent-chat__composer-actions">
                      <button
                        class="chat-send-btn"
                        type="button"
                        aria-label=${t("custodian.send")}
                        ?disabled=${!store.input.trim() || !store.canSend}
                        @click=${() => void store.send()}
                      >
                        ${icons.arrowUp}
                        <span class="agent-chat__control-label">${t("custodian.send")}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>`
        }
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-surface")) {
  customElements.define("openclaw-custodian-surface", CustodianSurface);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-surface": CustodianSurface;
  }
}
