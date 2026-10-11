import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For, onCleanup, Show, untrack } from "solid-js";
import { SYSTEM_AGENT_ID } from "../../../../src/system-agent/agent-id.js";
import { MarkdownBlocks } from "../../components/markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { handleMarkdownTableInteraction } from "../../components/markdown-tables.ts";
import { OptionCard } from "../../components/option-card.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import "../../components/openclaw-mascot.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, LitContent, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import "../../styles/chat/startup-layout.css";
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
import { CustodianAlertCard } from "./custodian-alert-card.tsx";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import { CustodianChannelOnboardingNudge, CustodianEventNudgeView } from "./custodian-nudge.tsx";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import { renderCustodianWizardControls } from "./custodian-surface.ts";
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

function TranscriptEntry(props: {
  store: () => CustodianSessionStore;
  message: CustodianMessage;
  activeWizardMessage: CustodianMessage | undefined;
}) {
  const question = () => props.message.question;
  const questionKey = () => `${props.message.id}:${question()?.id}`;
  return (
    <>
      <Show when={props.message.text}>
        <LitContent
          render={() =>
            renderMessageGroup(toCustodianMessageGroup(props.message), {
              showReasoning: false,
              showToolCalls: false,
              assistantName: t("custodian.title"),
              agentId: SYSTEM_AGENT_ID,
            })
          }
        />
      </Show>
      <Show when={props.message.id === props.store().earlierBoundaryAfterId}>
        <LitContent
          render={() =>
            renderChatDivider({
              kind: "divider",
              key: "custodian-earlier",
              label: t("custodian.earlier"),
              timestamp: props.message.at,
            })
          }
        />
      </Show>
      <Show when={question() && !props.store().dismissedQuestions.has(questionKey())}>
        <div class="custodian__option-card">
          <OptionCard
            props={{
              header: question()!.header,
              question: question()!.question,
              options: question()!.options.map((option) => ({
                value: option.label,
                label: option.label,
                description: option.description,
                recommended: option.recommended,
              })),
              disabled:
                !props.store().canSend || props.store().answeredQuestions.has(questionKey()),
              onSelect: (label: string) => props.store().answerQuestion(props.message, label),
              onSkip: () => void props.store().dismissQuestion(props.message),
            }}
          />
        </div>
      </Show>
      <Show when={props.message === props.activeWizardMessage ? props.message.step : null}>
        {(step) => (
          <section
            class="custodian__wizard-step"
            aria-label={formatUiExternalText(step().title ?? step().message, "Setup")}
          >
            <Show when={step().title}>
              <strong class="custodian__wizard-title">{formatUiExternalText(step().title!)}</strong>
            </Show>
            <LitContent
              render={() => renderCustodianWizardControls(props.store(), props.message, step())}
            />
          </section>
        )}
      </Show>
    </>
  );
}

export type CustodianSurfaceProps = {
  store: CustodianSessionStore;
  onboarding: boolean;
  newAgentIntent: boolean;
  showChannelOnboardingNudge: boolean;
  channelOnboardingError: string | null;
  channelOnboardingRetrying: boolean;
  onRetryChannelOnboarding: () => void;
  compact: boolean;
  historyContent: JSX.Element;
};

function CustodianSurfaceView(props: CustodianSurfaceProps, host: HTMLElement) {
  const context = useApplication();
  const projection = projectSource(
    untrack(() => props.store),
    {
      read: (store) => store,
      subscribe: (store, notify) => store.subscribe(notify),
      equality: "revision",
    },
  );
  const alerts = projectSource(custodianAlertStore, {
    read: (store) => store.alert,
    subscribe: (store, notify) => store.subscribe(notify),
    equality: "revision",
  });
  const store = () => projection.read();
  const currentAlert = createMemo(() => {
    // Alert admission derives from the session's current authority as well as the alert store.
    projection.revision();
    return alerts.read();
  });
  createEffect(
    () => [props.store, props.onboarding, props.newAgentIntent] as const,
    ([source, onboarding, newAgentIntent]) => {
      projection.replaceSource(source);
      source.connect(context, sessionVariant(onboarding, newAgentIntent));
    },
  );
  const plugin = () => {
    store();
    return currentPluginHelpReference(context);
  };
  const placeholder = () =>
    plugin()
      ? t("custodian.pluginPlaceholder", { plugin: plugin()!.name })
      : t("custodian.placeholder");
  const activeWizardMessage = () =>
    store().wizardInputPending
      ? store().messages.findLast((message) => message.step !== null)
      : undefined;
  const pluginWelcome = () =>
    Boolean(
      plugin() &&
      store().activeVariant === "caretaker" &&
      !store().sensitive &&
      !store().hasUnresolvedQuestion(),
    );
  const pluginIntro = () => pluginWelcome() && !store().hasRealUserTurn();
  const messages = createMemo(() =>
    store().messages.filter((message) => !pluginWelcome() || !message.optionalWelcome),
  );
  let textarea: HTMLTextAreaElement | null = null;
  let transcript: HTMLElement | null = null;
  let markdown: MarkdownBlocks | undefined;
  let lastMessageId: number | null = null;
  let lastPluginHelpFocus = 0;
  createEffect(
    () => ({ revision: projection.revision(), alert: alerts.read(), setup: store().setupRequired }),
    () =>
      untrack(() => {
        const nextTextarea = host.querySelector<HTMLTextAreaElement>("textarea");
        if (textarea && textarea !== nextTextarea) {
          disconnectTextareaOverflowObserver(textarea);
        }
        textarea = nextTextarea;
        if (textarea) {
          observeTextareaOverflow(textarea);
          adjustTextareaHeight(textarea);
        }
        const nextTranscript = host.querySelector<HTMLElement>(".custodian__messages");
        if (transcript !== nextTranscript) {
          markdown?.dispose();
          transcript = nextTranscript;
          markdown = transcript ? new MarkdownBlocks(transcript) : undefined;
        }
        markdown?.update(true);
        if (store().canSend && !store().sensitive && !store().hasUnresolvedQuestion()) {
          custodianAlertStore.askIfReady(
            (question, admission, display) =>
              void store().send(question, display, false, admission),
          );
        }
        const focusRequest = pluginHelpFocusRequest(context);
        if (
          focusRequest > 0 &&
          focusRequest !== lastPluginHelpFocus &&
          !store().sensitive &&
          !store().wizardInputPending &&
          store().chatAvailable
        ) {
          lastPluginHelpFocus = focusRequest;
          textarea?.focus();
        }
        const messageId = store().messages.at(-1)?.id ?? null;
        if (messageId !== lastMessageId) {
          lastMessageId = messageId;
          const lastChild = transcript?.lastElementChild;
          const lastMessage = lastChild?.classList.contains("lit-content")
            ? lastChild.lastElementChild
            : lastChild;
          if (lastMessage instanceof HTMLElement) {
            lastMessage.scrollIntoView?.({ block: "nearest" });
          }
        }
      }),
  );
  onCleanup(() => {
    if (textarea) {
      disconnectTextareaOverflowObserver(textarea);
    }
    markdown?.dispose();
  });
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    void store().send();
  };
  const alertCard = () => (
    <Show when={currentAlert()}>
      {(alert) => (
        <CustodianAlertCard
          alert={alert()}
          context={context}
          onDismiss={() => custodianAlertStore.dismiss()}
        />
      )}
    </Show>
  );
  return (
    <Show
      when={!store().setupRequired}
      fallback={
        <section
          class={[
            "custodian-surface custodian-surface--setup-required",
            { "custodian-surface--panel": props.compact },
          ]}
        >
          {alertCard()}
          <div class="custodian__setup-state" role="alert">
            <openclaw-mascot mood="idle" prop:size={props.compact ? 72 : 96} />
            <h2>{t("modelSetup.required.title")}</h2>
            <p>{t("modelSetup.required.body")}</p>
            <div class="custodian__setup-actions">
              <button
                class="btn primary"
                type="button"
                onClick={() => store().exitSetup("model-setup")}
              >
                {t("modelSetup.required.action")}
              </button>
            </div>
          </div>
        </section>
      }
    >
      <section
        class={[
          "custodian-surface",
          {
            "custodian-surface--panel": props.compact,
            "custodian-surface--empty-error":
              store().messages.length === 0 && store().error !== null && !store().sending,
          },
        ]}
      >
        <div
          class="custodian__messages"
          aria-live="polite"
          onClick={(event) => {
            handleMarkdownCodeBlockClick(event);
            handleMarkdownTableInteraction(event);
          }}
        >
          {alertCard()}
          <Show when={props.channelOnboardingError || props.showChannelOnboardingNudge}>
            <CustodianChannelOnboardingNudge
              error={Boolean(props.channelOnboardingError)}
              retrying={props.channelOnboardingRetrying}
              onAction={() =>
                props.channelOnboardingError
                  ? props.onRetryChannelOnboarding()
                  : store().openChannelsFromOnboarding()
              }
              onDismiss={() => store().dismissChannelOnboardingNudge()}
            />
          </Show>
          <Show when={!props.onboarding && !store().eventNudgePending ? store().eventNudge : null}>
            {(nudge) => (
              <CustodianEventNudgeView
                nudge={nudge()}
                disabled={!store().canSend || store().sensitive || store().hasUnresolvedQuestion()}
                onSend={() => void store().sendEventNudge()}
                onDismiss={() => store().dismissEventNudge()}
              />
            )}
          </Show>
          <Show when={pluginIntro()}>
            <div class="custodian__plugin-intro">
              <h2>{t("custodian.pluginIntroTitle", { plugin: plugin()!.name })}</h2>
              <div class="custodian__plugin-starters">
                <For
                  each={
                    [
                      ["custodian.pluginStarterPurpose", "custodian.pluginPromptPurpose"],
                      ["custodian.pluginStarterTools", "custodian.pluginPromptTools"],
                      ["custodian.pluginStarterSetup", "custodian.pluginPromptSetup"],
                    ] as const
                  }
                >
                  {(keys) => (
                    <button
                      class="btn"
                      type="button"
                      onClick={() => {
                        const reference = plugin();
                        if (reference) {
                          void createPluginHelpRequest(
                            context,
                            reference,
                          )({
                            question: t(keys[1], { plugin: reference.name }),
                          });
                        }
                      }}
                    >
                      {t(keys[0])}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <For each={messages()} keyed={(message) => message.id}>
            {(message) => (
              <TranscriptEntry
                store={store}
                message={message()}
                activeWizardMessage={activeWizardMessage()}
              />
            )}
          </For>
          <Show when={store().sending}>
            <div class="chat-group assistant custodian__thinking-row" role="status">
              <div class="chat-avatar assistant custodian__mascot-avatar" aria-hidden="true">
                <openclaw-mascot mood="thinking" prop:size={26} />
              </div>
              <div class="chat-group-messages custodian__thinking">
                <span />
                <span />
                <span />
                <span class="sr-only">{t("custodian.thinking")}</span>
              </div>
            </div>
          </Show>
          <Show when={store().abandonedTurnOutcomeUnknown}>
            <div class="custodian__error" role="alert">
              <span>{t("custodian.connectionChanged")}</span>
            </div>
          </Show>
          <PanelRefreshStatus
            status={store().transcript.status}
            // oxlint-disable-next-line solid/no-react-specific-props -- Shared status component names its CSS class prop className.
            className="custodian__transcript-status"
          />
          <Show
            when={
              store().error &&
              !(
                store().abandonedTurnOutcomeUnknown &&
                store().error === t("custodian.connectionChanged")
              )
            }
          >
            <div class="custodian__error" role="alert">
              <span>{store().error}</span>
              <Show when={store().activeClient && store().chatAvailable && store().canRetry()}>
                <button class="btn btn--sm" type="button" onClick={() => store().retry()}>
                  {t("common.retry")}
                </button>
              </Show>
            </div>
          </Show>
        </div>
        {props.historyContent}
        <Show when={!activeWizardMessage()}>
          <div class="agent-chat__composer-shell">
            <div class="agent-chat__input">
              <div class="agent-chat__composer-input-row">
                <div class="agent-chat__composer-combobox">
                  <Show
                    when={store().sensitive}
                    fallback={
                      <textarea
                        rows="1"
                        value={store().input}
                        autocomplete="on"
                        placeholder={placeholder()}
                        aria-label={placeholder()}
                        disabled={!store().chatAvailable}
                        onInput={(event) => store().setInput(event.currentTarget.value)}
                        onKeyDown={handleKeydown}
                      />
                    }
                  >
                    <input
                      type="password"
                      value={store().input}
                      autocomplete="off"
                      placeholder={t("custodian.sensitivePlaceholder")}
                      aria-label={t("custodian.sensitivePlaceholder")}
                      disabled={!store().canSend}
                      onInput={(event) => store().setInput(event.currentTarget.value)}
                      onKeyDown={handleKeydown}
                    />
                  </Show>
                  <span class="agent-chat__composer-placeholder" aria-hidden="true">
                    {store().sensitive ? t("custodian.sensitivePlaceholder") : placeholder()}
                  </span>
                </div>
                <div class="agent-chat__composer-actions">
                  <button
                    class="chat-send-btn"
                    type="button"
                    aria-label={t("custodian.send")}
                    disabled={!store().input.trim() || !store().canSend}
                    onClick={() => void store().send()}
                  >
                    <Icon name="arrowUp" />
                    <span class="agent-chat__control-label">{t("custodian.send")}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </section>
    </Show>
  );
}

export const CustodianSurface = defineSolidBridge<CustodianSurfaceProps>(
  "openclaw-custodian-surface",
  CustodianSurfaceView,
  {
    properties: {
      store: { default: custodianSessionStore, attribute: false },
      onboarding: { default: false, attribute: false },
      newAgentIntent: { default: false, attribute: false },
      showChannelOnboardingNudge: { default: false, attribute: false },
      channelOnboardingError: { default: null, attribute: false },
      channelOnboardingRetrying: { default: false, attribute: false },
      onRetryChannelOnboarding: { default: () => undefined, attribute: false },
      compact: { default: false, attribute: false },
      historyContent: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-surface": SolidBridgeElement<CustodianSurfaceProps>;
  }
}
