import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import type { QueuedChatSendOptions, QueuedChatSendResult } from "./chat-outbox-drain.ts";
import type { ChatHost } from "./chat-send-contract.ts";

export async function deliverChatQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  options: QueuedChatSendOptions = {},
): Promise<QueuedChatSendResult> {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const storageMode = options.storageMode ?? "durable";
  const routingSessionKey = options.routingSessionKey ?? sessionKey;
  const deliveryConnectionIsCurrent = captureChatConnectionOwner(host, false);
  const deliveryAgentId =
    item.agentId ?? scopedAgentIdForSession(host, routingSessionKey) ?? undefined;
  const deliveryWasVisible = visibleSessionMatches(host, routingSessionKey, deliveryAgentId);
  const sendOptions = { ...options, routingSessionKey, storageMode };
  // Admission and composer clearing happen before this boundary. Retain their
  // routing facts while fetching the transport implementation; navigation leaves
  // a foreground submission queued for the next recovery wake.
  const { deliverCapturedChatQueueItem } = await import("./chat-send-delivery.runtime.ts");
  if (
    !deliveryConnectionIsCurrent() ||
    (deliveryWasVisible && !visibleSessionMatches(host, routingSessionKey, deliveryAgentId))
  ) {
    return "pending";
  }
  return deliverCapturedChatQueueItem(host, item, sendOptions, {
    sessionKey,
    storageMode,
    routingSessionKey,
    deliveryConnectionIsCurrent,
    deliveryAgentId,
  });
}
