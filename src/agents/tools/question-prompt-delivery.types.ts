import type { ReplyPayload } from "../../auto-reply/reply-payload.js";

/**
 * Leaf contract for how a run shows a blocking question tool's prompt. Run
 * params and the prompt publisher both depend on it, so it stays import-free
 * beyond the payload type to keep the runner and tool graphs acyclic.
 */
export type QuestionPromptSend = (
  payload: ReplyPayload,
  options?: { signal?: AbortSignal },
) => void | Promise<void>;

/** A run's own way to show a question prompt, plus the channel it would appear in. */
export type QuestionPromptDelivery = {
  send: QuestionPromptSend;
  messageChannel?: string;
  /**
   * Conversation session whose plain-text replies may answer the prompt shown
   * there, in addition to the run's own session. A Voice Call consult sets it
   * to the chat that requested the call.
   */
  answerSessionKey?: string;
};
