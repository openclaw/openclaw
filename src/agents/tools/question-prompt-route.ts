import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../../channels/message/runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** A direct chat route a question prompt can be sent to. */
export type QuestionPromptRoute = {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

/** Sends one prompt durably to a route, rejecting unless it may have reached the chat. */
export async function sendQuestionPromptToRoute(
  params: QuestionPromptRoute & {
    payload: ReplyPayload;
    signal?: AbortSignal;
    /** Fences the final adapter call and the platform dispatch on the sender's authority. */
    handoff?: { assertCurrent: () => void; confirmCurrent: () => Promise<void> };
  },
): Promise<void> {
  const send = await sendDurableMessageBatchCore({
    cfg: params.cfg,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
    payloads: [params.payload],
    bestEffort: false,
    durability: "required",
    deliveryRetryOwner: "caller",
    signal: params.signal,
    ...(params.handoff
      ? {
          assertDirectAdapterHandoff: params.handoff.assertCurrent,
          onPlatformSendDispatch: params.handoff.confirmCurrent,
        }
      : {}),
  });
  // Fail closed when the durable batch did not reach the chat. ask_user then
  // cancels instead of waiting on Control UI after a suppressed or failed send.
  if (durableMessageBatchMayHaveReachedRecipient(send)) {
    return;
  }
  if (send.status === "failed") {
    throw send.error;
  }
  throw new Error(
    send.status === "suppressed"
      ? `question prompt delivery was suppressed: ${send.reason}`
      : "question prompt delivery did not reach the conversation",
  );
}
