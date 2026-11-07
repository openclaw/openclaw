import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  Errored,
  For,
  latest,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import "../../components/openclaw-mascot.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/grouped.css";
import "../../styles/option-card.css";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-surface.css";
import "../../styles/chat/text.css";
import "../../styles/custodian.css";
import {
  adjustTextareaHeight,
  handleTextareaOverflowInteraction,
  handleTextareaOverflowScroll,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
} from "../chat/components/chat-composer-dom.ts";
import { ChatLazyBoundary } from "../chat/components/chat-lazy-boundary.tsx";
import { createCustodianActions, type CustodianActions } from "./custodian-actions.ts";
import { CustodianAlertCard } from "./custodian-alert-card.tsx";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import { CustodianEventNudgeView } from "./custodian-nudge.tsx";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSetupCard } from "./custodian-setup-card.tsx";
import {
  createPluginHelpRequest,
  currentPluginHelpReference,
  pluginHelpFocusRequest,
} from "./plugin-help.ts";
import { sessionVariant } from "./session-lifecycle.ts";

registerPluginManagementEnglish();

const CustodianTranscript = lazy(() => import("./custodian-transcript.tsx"), {
  export: "CustodianTranscript",
});

export type CustodianSurfaceProps = {
  store: CustodianSessionStore;
  actions?: CustodianActions;
  onboarding: boolean;
  newAgentIntent: boolean;
  channelOnboardingContent: JSX.Element;
  compact: boolean;
  historyContent: JSX.Element;
};

type CustodianSurfaceElement = SolidBridgeElement<CustodianSurfaceProps>;
const inputChanges = new WeakMap<CustodianSurfaceElement, () => void>();

function CustodianSurfaceView(props: CustodianSurfaceProps, host: CustodianSurfaceElement) {
  const context = useApplication();
  const presentation = createCustodianActions(() => host.store);
  const projection = createMemo(() => projectOwner(props.store, (store) => store));
  const alerts = projectOwner(custodianAlertStore, (store) => store.alert);
  const store = () => projection().read();
  const actions = () => props.actions ?? presentation.actions;
  const ownerSending = createMemo(() => store().sending);
  const sending = () => actions().session.sending || ownerSending();
  const eventNudge = createMemo(() => {
    const source = store();
    return source.eventNudgePending ? null : source.eventNudge;
  });
  const transcriptStatus = createMemo(() => {
    const transcript = store().transcript;
    const completion = transcript.completion ?? Promise.resolve(transcript.status);
    return completion.then((status) => {
      if (status.error) {
        throw new Error(status.error);
      }
      return status;
    });
  });
  const currentAlert = createMemo(() => {
    // Alert admission derives from the session's current authority as well as the alert store.
    projection().revision();
    return alerts.read();
  });
  let queued = false;
  function connectSession(): void {
    queued = false;
    const { store: source, onboarding, newAgentIntent } = host;
    source.connect(context, sessionVariant(onboarding, newAgentIntent));
  }
  onSettled(() => {
    inputChanges.set(host, () => {
      presentation.retire();
      if (!queued) {
        queued = true;
        // Bridge properties arrive separately during one render.
        queueMicrotask(() => {
          if (queued) {
            connectSession();
          }
        });
      }
    });
    // Fetch the renderer while the owner reads history and prepares the greeting.
    void CustodianTranscript.preload().catch(() => undefined);
    connectSession();
    return () => {
      inputChanges.delete(host);
      queued = false;
      if (textarea) {
        disconnectTextareaOverflowObserver(textarea);
      }
    };
  });
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
  let textareaNode: HTMLTextAreaElement | null = null;
  let transcriptNode: HTMLDivElement | null = null;
  let lastPluginHelpFocus = 0;
  // The composer requires committed nodes; alerts retain send admission.
  createEffect(
    () => ({
      source: store(),
      alert: alerts.read(),
    }),
    ({ source }) => {
      const nextTextarea = host.contains(textareaNode) ? textareaNode : null;
      if (textarea && textarea !== nextTextarea) {
        disconnectTextareaOverflowObserver(textarea);
      }
      textarea = nextTextarea;
      if (textarea) {
        observeTextareaOverflow(textarea);
        adjustTextareaHeight(textarea);
      }
      if (source.canSend && !source.sensitive && !source.hasUnresolvedQuestion()) {
        custodianAlertStore.askIfReady(
          (question, admission, display) => void source.send(question, display, false, admission),
        );
      }
    },
  );
  createPendingFocus(() => ({ source: store(), request: pluginHelpFocusRequest(context) }), {
    requested: ({ request }) => request > 0 && request !== lastPluginHelpFocus,
    ready: ({ source }) => !source.sensitive && !source.wizardInputPending && source.chatAvailable,
    focus: ({ request }) => {
      lastPluginHelpFocus = request;
      if (host.contains(textareaNode)) {
        textareaNode?.focus();
      }
    },
  });
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    actions().session.send();
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
  const setupCard = () => (
    <Show when={props.onboarding}>
      <CustodianSetupCard store={store()} actions={actions().setup} />
    </Show>
  );
  const transcriptNotice = (status: CustodianSessionStore["transcript"]["status"]) => (
    <PanelRefreshStatus
      status={status}
      // oxlint-disable-next-line solid/no-react-specific-props -- Shared status component names its CSS class prop className.
      className="custodian__transcript-status"
    />
  );
  return (
    <Show
      when={!store().setupRequired && !store().autoSetup.blocksGreeting}
      fallback={
        <section
          class={[
            "custodian-surface custodian-surface--setup-required",
            { "custodian-surface--panel": props.compact },
          ]}
        >
          {setupCard()}
          {alertCard()}
          <Show when={!store().autoSetup.blocksGreeting || store().autoSetup.dismissed}>
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
          </Show>
        </section>
      }
    >
      <section
        class={[
          "custodian-surface",
          {
            "custodian-surface--panel": props.compact,
            "custodian-surface--empty-error":
              store().messages.length === 0 && store().error !== null && !sending(),
          },
        ]}
      >
        <div ref={(node) => (transcriptNode = node)} class="custodian__messages" aria-live="polite">
          {setupCard()}
          {alertCard()}
          {props.channelOnboardingContent}
          {/* Independent health events stay visible while a user turn is pending. */}
          <Show when={!props.onboarding ? latest(eventNudge) : null}>
            {(nudge) => (
              <CustodianEventNudgeView
                nudge={nudge()}
                disabled={!store().canSend || store().sensitive || store().hasUnresolvedQuestion()}
                onSend={() => actions().session.sendEventNudge()}
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
          <ChatLazyBoundary>
            <CustodianTranscript
              store={store}
              actions={actions().session}
              messages={messages()}
              activeWizardMessage={activeWizardMessage()}
              region={() => (host.contains(transcriptNode) ? transcriptNode : null)}
            />
          </ChatLazyBoundary>
          {/* Mount the canvas from owner admission, outside the pending action. */}
          <Show when={ownerSending()}>
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
          <Loading
            on={store().transcript.completion}
            fallback={transcriptNotice(store().transcript.status)}
          >
            <Errored fallback={(_error) => transcriptNotice(store().transcript.status)}>
              {transcriptNotice(transcriptStatus())}
            </Errored>
          </Loading>
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
                <button class="btn btn--sm" type="button" onClick={() => actions().session.retry()}>
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
                        ref={(node) => (textareaNode = node)}
                        rows="1"
                        value={store().input}
                        autocomplete="on"
                        placeholder={placeholder()}
                        aria-label={placeholder()}
                        disabled={!store().chatAvailable}
                        onInput={(event) => {
                          handleTextareaOverflowInteraction(event);
                          store().setInput(event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          handleTextareaOverflowInteraction(event);
                          handleKeydown(event);
                        }}
                        onBeforeInput={handleTextareaOverflowInteraction}
                        onCompositionStart={handleTextareaOverflowInteraction}
                        onBlur={handleTextareaOverflowInteraction}
                        onWheel={handleTextareaOverflowInteraction}
                        onPointerDown={handleTextareaOverflowInteraction}
                        onScroll={handleTextareaOverflowScroll}
                      />
                    }
                  >
                    <input
                      type="password"
                      value={store().input}
                      autocomplete="off"
                      placeholder={t("custodian.sensitivePlaceholder")}
                      aria-label={t("custodian.sensitivePlaceholder")}
                      disabled={sending() || !store().canSend}
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
                    disabled={sending() || !store().input.trim() || !store().canSend}
                    onClick={() => actions().session.send()}
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
    propertyChanged: (host, key) => {
      if (key === "store" || key === "onboarding" || key === "newAgentIntent") {
        inputChanges.get(host)?.();
      }
    },
    properties: {
      store: { default: custodianSessionStore, attribute: false },
      actions: { default: undefined, attribute: false },
      onboarding: { default: false, attribute: false },
      newAgentIntent: { default: false, attribute: false },
      channelOnboardingContent: { default: undefined, attribute: false },
      compact: { default: false, attribute: false },
      historyContent: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-surface": CustodianSurfaceElement;
  }
}
