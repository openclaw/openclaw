import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  isVolatileQueuedMessage,
  updateQueuedMessage,
  updateVolatileQueuedMessage,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueScopedSessionHost) {
  const items = chatOutboxOwner(host).allItems(host);
  for (const item of items) {
    if (!item.sendRunId || (item.sendState !== "sending" && item.sendState !== "waiting-idle")) {
      continue;
    }
    // An unsent row held by an editor cannot be in flight. Keep its captured
    // version valid; the drain still reconciles it after the edit is released.
    if (
      item.sendState === "waiting-idle" &&
      item.sendAttempts === 0 &&
      item.sendRequestStartedAtMs === undefined &&
      isQueuedMessageBeingEdited(host, item.id)
    ) {
      continue;
    }
    if (isVolatileQueuedMessage(host, item.id)) {
      updateVolatileQueuedMessage(host, item.id, (current) => ({
        ...current,
        sendState: "unconfirmed",
      }));
      continue;
    }
    updateQueuedMessage(host, item.id, (current) => ({
      ...current,
      sendState: "waiting-reconnect",
    }));
  }
}
