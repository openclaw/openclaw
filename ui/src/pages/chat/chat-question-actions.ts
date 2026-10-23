import { cancelQuestionPrompt, submitQuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";

type QuestionActionOptions = {
  state: Pick<
    ChatPageHost,
    "sessionKey" | "connectionEpoch" | "handleSendChat" | "lastError" | "chatQueue"
  >;
  questionState: Parameters<typeof submitQuestionPrompt>[0];
  canSend: boolean;
  isCurrent: () => boolean;
};

export function createChatQuestionActions({
  state,
  questionState,
  canSend,
  isCurrent,
}: QuestionActionOptions): Pick<
  ChatProps,
  | "onGatewayQuestionChange"
  | "onGatewayQuestionSubmit"
  | "onGatewayQuestionSkip"
  | "onAsyncQuestionSubmit"
> {
  const sessionKey = state.sessionKey;
  const connectionEpoch = state.connectionEpoch;
  const ownsSubmission = () =>
    state.sessionKey === sessionKey && state.connectionEpoch === connectionEpoch && isCurrent();
  return {
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
          // Stream-only questions cannot claim a shared answer until their
          // canonical source exists. A failed attempt must not create an outbox claim.
          if (!itemId || !sourceMessageId) {
            return false;
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
