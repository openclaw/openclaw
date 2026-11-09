import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatQuestionsEnglish } from "../../../i18n/locales/en-chat-questions.ts";
import "./chat-question-card-view.tsx";
import type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-types.ts";

registerChatQuestionsEnglish();

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
      requestedBySession: options.requestedBySession,
      requestedBySessionHref: options.requestedBySessionHref,
      autoFocus: options.requestedBySession ? false : undefined,
      requestPosition: options.requestPosition,
    },
    onChange,
    onOpenSession: options.onOpenSession,
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

export type { ChatQuestionCard } from "./chat-question-card-view.tsx";
