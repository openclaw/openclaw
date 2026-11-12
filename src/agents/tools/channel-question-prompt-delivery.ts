import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel-normalize.js";
import { sendQuestionPromptToRoute } from "./question-prompt-route.js";
import type { ConversationQuestionPromptDelivery } from "./question-prompt-send.js";

/** Builds a portable prompt sender for Gateway-scoped / loopback tool construction. */
export function createChannelQuestionPromptDelivery(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  to?: string | number | null;
  accountId?: string;
  threadId?: string | number | null;
}): ConversationQuestionPromptDelivery | undefined {
  const cfg = params.cfg;
  const channel = normalizeMessageChannel(params.channel);
  const to = params.to?.toString().trim();
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  return {
    messageChannel: channel,
    send: (payload, options) =>
      sendQuestionPromptToRoute({
        cfg,
        channel,
        to,
        accountId: params.accountId,
        threadId: params.threadId ?? undefined,
        payload,
        signal: options?.signal,
      }),
  };
}
