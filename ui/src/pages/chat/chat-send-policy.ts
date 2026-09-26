import type { ChatSendIntent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { normalizeChatFollowUpModeOverride } from "../../app/settings.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { ChatHost } from "./chat-send-contract.ts";

type ChatSendPolicyInput = {
  source?: Pick<ChatQueueItem, "queueMode" | "deliveryPolicy">;
  followUpMode?: ControlUiFollowUpMode;
  intent?: ChatSendIntent;
  applyRunPolicy: boolean;
  userMessage: string;
  hasCommand: boolean;
  hasReply: boolean;
  hasWorkContext: boolean;
  hasAttachments: boolean;
};

/** Capture delivery intent once, before the outbox takes custody of the input. */
export function resolveChatSendPolicy(host: ChatHost, input: ChatSendPolicyInput) {
  const { source, intent, applyRunPolicy, userMessage } = input;
  const browserOverride = normalizeChatFollowUpModeOverride(host.settings?.chatFollowUpMode);
  // Editing preserves the row's delivery choice; current composer defaults must
  // not turn an explicitly queued message into a steer or interrupt.
  const followUpMode =
    input.followUpMode ??
    (source ? (source.queueMode ?? "queue") : (host.chatFollowUpMode ?? browserOverride));
  // An edited/retried row owns its original intent, independent of today's toggle.
  const deliveryPolicy = input.followUpMode
    ? undefined
    : source
      ? source.deliveryPolicy
      : !input.followUpMode &&
          !intent &&
          !input.hasCommand &&
          !input.hasReply &&
          !input.hasWorkContext &&
          !input.hasAttachments &&
          !host.selectedChatSessionIncognito &&
          !userMessage.startsWith("/") &&
          !userMessage.startsWith("!") &&
          userMessage.length <= 8_000 &&
          applyRunPolicy &&
          host.settings.chatAutoSteer === true &&
          host.isAutoSteerAvailable?.()
        ? ("auto" as const)
        : undefined;
  // Auto carries explicit browser queue/steer choices, but leaves inherited
  // server semantics to the Gateway after classification.
  const activeRunQueueMode = deliveryPolicy
    ? source
      ? source.queueMode
      : browserOverride === "queue"
        ? "followup"
        : browserOverride === "steer"
          ? "steer"
          : undefined
    : !intent && applyRunPolicy && followUpMode !== "queue"
      ? followUpMode
      : undefined;
  const allowActiveRunSend = Boolean(
    deliveryPolicy || intent || (applyRunPolicy && followUpMode !== "queue"),
  );
  return { deliveryPolicy, activeRunQueueMode, allowActiveRunSend };
}
