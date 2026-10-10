import { html, nothing } from "lit";
import { SYSTEM_AGENT_ID } from "../../../../src/system-agent/agent-id.js";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { renderChatDivider } from "../chat/components/chat-divider.ts";
import { renderMessageGroup } from "../chat/components/chat-message.ts";
import "../../components/option-card.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import type { CustodianMessage } from "./transcript.ts";

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

export function renderCustodianTranscriptEntry(
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
