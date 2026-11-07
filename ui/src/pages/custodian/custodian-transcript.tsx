import { For, onSettled, Show } from "solid-js";
import { SYSTEM_AGENT_ID } from "../../../../src/system-agent/agent-id.js";
import { handleMarkdownCodeBlockClick } from "../../components/markdown-code-blocks.ts";
import { markdownBlocksRef as createMarkdownBlocksRef } from "../../components/markdown-element-refs-solid.ts";
import { handleMarkdownTableInteraction } from "../../components/markdown-tables.ts";
import { OptionCard } from "../../components/option-card.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import type { MessageGroup as MessageGroupData } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createScrollPosition } from "../../lib/reactive/scroll-state.ts";
import { ChatDivider } from "../chat/components/chat-divider.tsx";
import { MessageGroup } from "../chat/components/chat-message-group-view.tsx";
import type { CustodianActions } from "./custodian-actions.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import type { CustodianMessage } from "./transcript.ts";

function toCustodianMessageGroup(message: CustodianMessage): MessageGroupData {
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
  actions: CustodianActions["session"];
  message: CustodianMessage;
  activeWizardMessage: CustodianMessage | undefined;
}) {
  const question = () => props.message.question;
  const questionKey = () => `${props.message.id}:${question()?.id}`;
  return (
    <>
      <Show when={props.message.text}>
        <MessageGroup
          group={toCustodianMessageGroup(props.message)}
          options={{
            showReasoning: false,
            showToolCalls: false,
            assistantName: t("custodian.title"),
            agentId: SYSTEM_AGENT_ID,
          }}
        />
      </Show>
      <Show when={props.message.id === props.store().earlierBoundaryAfterId}>
        <ChatDivider
          item={{
            kind: "divider",
            key: "custodian-earlier",
            label: t("custodian.earlier"),
            timestamp: props.message.at,
          }}
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
                props.actions.sending ||
                !props.store().canSend ||
                props.store().answeredQuestions.has(questionKey()),
              onSelect: (label: string) => props.actions.answerQuestion(props.message, label),
              onSkip: () => props.actions.dismissQuestion(props.message),
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
            <WizardStepControls
              step={step()}
              value={props.store().wizardValue}
              busy={props.actions.sending || !props.store().canSend}
              inputId={`custodian-wizard-input-${props.message.id}`}
              sensitiveRevealed={props.store().wizardSecretVisible}
              onValueChange={(value) => props.store().setWizardValue(value)}
              onAnswer={(value) => props.actions.answerWizardStep(props.message, value)}
              onToggleSensitiveVisibility={() => props.store().toggleWizardSecretVisibility()}
              leadingAction={
                props.store().wizardCancelAvailable ? (
                  <button
                    class="btn btn--ghost custodian__wizard-cancel"
                    type="button"
                    disabled={props.actions.sending || !props.store().canSend}
                    onClick={() => props.actions.cancelWizardStep(props.message)}
                  >
                    {t("custodian.cancel")}
                  </button>
                ) : undefined
              }
            />
          </section>
        )}
      </Show>
    </>
  );
}

export function CustodianTranscript(props: {
  store: () => CustodianSessionStore;
  actions: CustodianActions["session"];
  messages: readonly CustodianMessage[];
  activeWizardMessage: CustodianMessage | undefined;
  region: () => HTMLElement | null;
}) {
  const bindMarkdown = createMarkdownBlocksRef(() => {
    void props.messages;
    return true;
  });
  onSettled(() => {
    const region = props.region();
    if (!region) {
      return undefined;
    }
    bindMarkdown(region);
    const stopClick = listen(region, "click", (event) => {
      handleMarkdownCodeBlockClick(event);
      handleMarkdownTableInteraction(event);
    });
    return stopClick;
  });
  let revealedMessages = false;
  createScrollPosition(() => {
    const initialMessageId = props.store().messages.at(-1)?.id ?? null;
    return {
      reveal: {
        identity: [initialMessageId],
        target: () => {
          // Wait for the lazy rows to commit before revealing the initial transcript.
          if (initialMessageId === null && !revealedMessages) {
            return undefined;
          }
          revealedMessages = true;
          const lastMessage = props.region()?.lastElementChild;
          return lastMessage instanceof HTMLElement ? lastMessage : undefined;
        },
      },
    };
  });
  return (
    <For each={props.messages} keyed={(message) => message.id}>
      {(message) => (
        <TranscriptEntry
          store={props.store}
          actions={props.actions}
          message={message()}
          activeWizardMessage={props.activeWizardMessage}
        />
      )}
    </For>
  );
}
