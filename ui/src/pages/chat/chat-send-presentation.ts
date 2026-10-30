import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";

export function isChatSendReconnecting(
  state: ChatQueueItem["sendState"],
  connected: boolean | undefined,
): boolean {
  // Delivery versions retain this state for recovery and captured edits. A
  // restart ack may briefly precede the socket close; connection owns the label.
  return state === "waiting-reconnect" && connected !== true;
}
