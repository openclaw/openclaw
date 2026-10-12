import { html, nothing } from "lit";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import type {
  QuestionPanelOptions,
  QuestionPanelProps,
  QuestionPanelQuestion,
} from "./chat-question-types.ts";
import "./chat-question-card-view.tsx";

export type {
  QuestionPanelOptions,
  QuestionPanelProps,
  QuestionPanelQuestion,
} from "./chat-question-types.ts";

export function createGatewayQuestionPanelProps(
  prompt: QuestionPrompt,
  options: QuestionPanelOptions,
): QuestionPanelProps {
  const { onChange, onSubmit, onSkip } = options;
  const checkedAction = <Args extends unknown[]>(
    action: ((...args: Args) => void | Promise<void>) | undefined,
  ) =>
    action
      ? async (...args: Args) => {
          await action(...args);
          if (prompt.status === "pending" && prompt.error) {
            throw new Error(prompt.error);
          }
        }
      : undefined;
  return {
    model: {
      requestKey: prompt.id,
      title: t("chat.questions.eyebrow"),
      questions: prompt.questions,
      agentId: prompt.agentId,
      sessionKey: prompt.sessionKey,
      secretStoreAllowedHostsDraft: prompt.secretStoreAllowedHostsDraft,
      collapsed: options.collapsed ?? false,
      disabled: prompt.status !== "pending",
      submitting: prompt.submitting,
      drafts: prompt.drafts,
      error: prompt.error,
      requestPosition: options.requestPosition,
    },
    onChange,
    onSecretStoreAllowedHostsChange: (allowedHosts) => {
      prompt.secretStoreAllowedHostsDraft = allowedHosts;
      onChange?.();
    },
    onSubmit: checkedAction(onSubmit),
    onSkip: checkedAction(onSkip),
    onDismissError:
      prompt.error && onChange
        ? () => {
            prompt.error = null;
            onChange();
          }
        : undefined,
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
  };
}

function terminalAnswer(prompt: QuestionPrompt, question: QuestionPanelQuestion): string {
  if (prompt.status === "cancelled") {
    return t("chat.questions.skipped");
  }
  if (prompt.status === "expired") {
    return t("chat.questions.expired");
  }
  if (prompt.status === "unavailable") {
    return t("chat.questions.unavailable");
  }
  if (question.isSecret) {
    return t("chat.questions.answered");
  }
  const answer = prompt.answers?.answers[question.questionId]?.join(", ");
  return (
    answer ||
    t(prompt.answeredElsewhere ? "chat.questions.answeredElsewhere" : "chat.questions.answered")
  );
}

export function renderChatQuestionSummary(prompt: QuestionPrompt) {
  if (prompt.status === "pending") {
    return nothing;
  }
  return html`
    <div class="chat-question-summary" aria-label=${t("chat.questions.summaryLabel")}>
      ${prompt.questions.map(
        (question) => html`
          <div class="chat-question-summary__item">
            <div class="chat-question-summary__prompt">${question.question}</div>
            <div class="chat-question-summary__line">
              <strong>${question.header}:</strong>
              <span>${terminalAnswer(prompt, question)}</span>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

export type { ChatQuestionCard } from "./chat-question-card-view.tsx";
