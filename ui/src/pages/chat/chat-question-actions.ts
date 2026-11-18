import {
  cancelQuestionPrompt,
  submitQuestionPrompt,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";

export function createChatQuestionActions({
  state,
  questionState,
  prompts,
  sendActions,
  canSend,
  isCurrent,
}: {
  state: Pick<
    ChatPageHost,
    "sessionKey" | "connectionEpoch" | "handleSendChat" | "lastError" | "chatQueue" | "chatMessage"
  >;
  questionState: Parameters<typeof submitQuestionPrompt>[0];
  prompts: readonly QuestionPrompt[];
  sendActions: Pick<ChatProps, "onSend" | "onPermissionRetry">;
  canSend: boolean;
  isCurrent: () => boolean;
}): Pick<
  ChatProps,
  | "onGatewayQuestionChange"
  | "onGatewayQuestionSubmit"
  | "onGatewayQuestionSkip"
  | "onAsyncQuestionSubmit"
  | "onSend"
  | "onPermissionRetry"
> {
  const sessionKey = state.sessionKey;
  const connectionEpoch = state.connectionEpoch;
  const ownsSubmission = () =>
    state.sessionKey === sessionKey && state.connectionEpoch === connectionEpoch && isCurrent();
  return {
    ...sendActions,
    onSend: async (...args) => {
      if (!ownsSubmission()) {
        return;
      }
      // Snapshot only this conversation's docked questions before sending. A new
      // question raised by the replacement turn must remain answerable.
      const pending = parseSlashCommand(state.chatMessage)
        ? []
        : prompts.filter((prompt) => prompt.status === "pending").map((prompt) => prompt.id);
      const client = questionState.client;
      const generation = questionState.clientGeneration;
      const accepted = await sendActions.onSend(...args);
      if (
        accepted === true &&
        ownsSubmission() &&
        questionState.client === client &&
        questionState.clientGeneration === generation
      ) {
        // Cancellation is not an answer or manual-step completion. The existing
        // question owner settles once and retains a visible error on failure.
        await Promise.all(pending.map((id) => cancelQuestionPrompt(questionState, id)));
      }
      return accepted;
    },
    onGatewayQuestionChange: questionState.onChange,
    onGatewayQuestionSubmit: (id, answers) => submitQuestionPrompt(questionState, id, answers),
    onGatewayQuestionSkip: (id) => cancelQuestionPrompt(questionState, id),
    onAsyncQuestionSubmit: canSend
      ? async (message, itemId, sourceMessageId) => {
          if (!ownsSubmission()) {
            return false;
          }
          if (itemId && state.chatQueue.some((item) => item.asyncQuestionItemId === itemId)) {
            return true;
          }
          let outboxAdmitted = false;
          let accepted: boolean | void = undefined;
          try {
            accepted = await state.handleSendChat(message, {
              followUpMode: "steer",
              asyncQuestionItemId: itemId,
              replyTargetOverride: sourceMessageId
                ? { messageId: sourceMessageId, sourceMessageId, text: "" }
                : null,
              onOutboxAdmitted: () => {
                outboxAdmitted = true;
              },
            });
          } catch (error) {
            if (!outboxAdmitted) {
              throw error;
            }
          }
          if (!ownsSubmission()) {
            return false;
          }
          if (!outboxAdmitted && !accepted && state.lastError) {
            throw new Error(state.lastError);
          }
          return outboxAdmitted || accepted === true;
        }
      : undefined,
  };
}
