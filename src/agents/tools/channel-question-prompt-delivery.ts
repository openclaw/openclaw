import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../../channels/message/runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel-normalize.js";
import type { QuestionPromptDelivery } from "./question-prompt-send.js";

/** Builds a portable prompt sender for Gateway-scoped / loopback tool construction. */
export function createChannelQuestionPromptDelivery(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  to?: string | number | null;
  accountId?: string;
  threadId?: string | number | null;
}): QuestionPromptDelivery | undefined {
  const cfg = params.cfg;
  const channel = normalizeMessageChannel(params.channel);
  const to = params.to?.toString().trim();
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  return {
    messageChannel: channel,
    send: async (payload, options) => {
      const send = await sendDurableMessageBatchCore({
        cfg,
        channel,
        to,
        accountId: params.accountId,
        threadId: params.threadId ?? undefined,
        payloads: [payload],
        bestEffort: false,
        durability: "required",
        deliveryRetryOwner: "caller",
        signal: options?.signal,
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
    },
  };
}
