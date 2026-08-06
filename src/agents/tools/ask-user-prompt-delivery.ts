import {
  buildAgentHarnessQuestionPromptPayload,
  type AgentHarnessQuestionPromptPayload,
} from "../harness/user-input-bridge.js";
import {
  cancelAskUserPromptDelivery,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./ask-user-tool.js";

export type AskUserPromptDeliveryReservation = {
  questionId: string;
  deliver: () => void;
  cancel: () => void;
};

/**
 * Reserves an ask_user prompt synchronously, then presents it once the Gateway
 * question is answerable. Tool execution waits for the delivery settlement.
 */
export function reserveAskUserPrompt(params: {
  toolCallId: string;
  sessionKey?: string;
  runId: string;
  args: unknown;
  deliver: (payload: AgentHarnessQuestionPromptPayload) => Promise<void> | void;
  onDeliveryError?: (error: unknown) => void;
}): AskUserPromptDeliveryReservation | undefined {
  let reservation: { questionId: string } | undefined;
  try {
    const { questions, timeoutSeconds } = normalizeAskUserParams(params.args);
    reservation = reserveAskUserPromptDelivery({
      toolCallId: params.toolCallId,
      sessionKey: params.sessionKey,
      runId: params.runId,
      questions,
      timeoutSeconds,
    });
  } catch {
    // Tool argument validation owns malformed calls; do not expose an unusable prompt.
    return undefined;
  }
  if (!reservation) {
    return undefined;
  }

  const { questionId } = reservation;
  let deliveryStarted = false;

  return {
    questionId,
    deliver: () => {
      if (deliveryStarted) {
        return;
      }
      deliveryStarted = true;
      void waitForAskUserPromptReady(questionId)
        .then(async (questions) => {
          if (!questions) {
            return;
          }
          await params.deliver(
            buildAgentHarnessQuestionPromptPayload({
              questionId,
              questions: questions.map(({ questionId: id, ...question }) => ({
                ...question,
                id,
              })),
              options: { intro: "Question for you:" },
            }),
          );
        })
        .then(
          () => settleAskUserPromptDelivery(questionId),
          (error: unknown) => {
            settleAskUserPromptDelivery(questionId, error);
            params.onDeliveryError?.(error);
          },
        );
    },
    cancel: () => cancelAskUserPromptDelivery(params.toolCallId, params.sessionKey, params.runId),
  };
}
