import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import { ChatQuestionSummary } from "./chat-question-summary.tsx";
import type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-types.ts";
import "./chat-question-card-view.tsx";

export type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-types.ts";

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

export function renderChatQuestionSummary(prompt: QuestionPrompt) {
  return solidContent(ChatQuestionSummary, { prompt });
}

export type { ChatQuestionCard } from "./chat-question-card-view.tsx";
