/** Shared prompt delivery for embedded tool-start handlers and self-publishing harnesses. */
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveControlUiSessionLinkBase } from "../../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithQuestionChannelDeliveries } from "../../infra/question-channel-runtime.js";
import { buildAgentHarnessQuestionPromptPayload } from "../harness/user-input-bridge.js";

/** Tools whose call opens a question a person must answer before the turn continues. */
export type QuestionPromptToolName = "ask_user" | "secrets";

/** Publishes one prompt into the originating conversation. */
export type QuestionPromptSend = (
  payload: ReplyPayload,
  options?: { signal?: AbortSignal },
) => void | Promise<void>;

/** A run's own way to show a question prompt, plus the channel it would appear in. */
export type QuestionPromptDelivery = {
  send: QuestionPromptSend;
  messageChannel?: string;
};

/** Host-generated capability guidance that is safe to return to the model. */
export class QuestionPromptUnavailableError extends Error {}

/**
 * Publishes the prompt for an already-committed gateway question record.
 *
 * Rejects when the question cannot become answerable where it was asked, which is
 * what tells the caller to cancel the pending record instead of waiting it out.
 */
export async function sendQuestionToolPrompt(params: {
  toolName: QuestionPromptToolName;
  questionId: string;
  questions: readonly QuestionRequestQuestion[];
  config?: OpenClawConfig;
  send: QuestionPromptSend;
  signal?: AbortSignal;
}): Promise<void> {
  const { questionId, questions } = params;
  const send: QuestionPromptSend = (payload) =>
    runWithQuestionChannelDeliveries([questionId], () =>
      params.signal ? params.send(payload, { signal: params.signal }) : params.send(payload),
    );
  if (params.toolName === "secrets") {
    const binding = questions[0]?.secretStore;
    if (!binding) {
      return;
    }
    const controlUiBase = resolveControlUiSessionLinkBase(params.config);
    const url = controlUiBase
      ? `${controlUiBase}/ask/${encodeURIComponent(questionId)}`
      : undefined;
    const prompt = [
      binding.name,
      ...(binding.reason ? [binding.reason] : []),
      "Enter the value in the form, not in chat.",
      ...(controlUiBase ? [`${new URL(controlUiBase).host} · Gateway sign-in required.`] : []),
    ].join("\n\n");
    const text = url
      ? `${prompt}\n\nOpen form: ${url}`
      : "No credential form link is configured. Retry in a trusted Control UI or native app, or use Settings or the masked CLI. Never paste credentials in chat.";
    await send({
      text,
      ...(url
        ? {
            presentation: {
              blocks: [
                { type: "text" as const, text: prompt },
                {
                  type: "buttons" as const,
                  buttons: [{ label: "Open form", action: { type: "url" as const, url } }],
                },
              ],
            },
            presentationTextMode: "fallback" as const,
          }
        : {}),
      // Navigation does not answer the request. Correlation lets the existing
      // channel lifecycle owner retire the form button after resolution.
      channelData: { askUser: { questionId } },
    });
    if (!controlUiBase) {
      // A visible blocker is not a delivered entry form; cancel the pending wait.
      throw new QuestionPromptUnavailableError(text);
    }
    return;
  }
  await send(
    buildAgentHarnessQuestionPromptPayload({
      questionId,
      questions: questions.map(({ questionId: id, ...question }) =>
        Object.assign(question, { id }),
      ),
      options: { intro: "Question for you:" },
    }),
  );
}
