import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import type { ChatQueueScopedSessionHost } from "./chat-queue.ts";

export function admitQueuedMessageForSession(
  host: ChatQueueScopedSessionHost,
  captured: ReturnType<typeof captureChatOutboxAdmission>,
  item: ChatQueueItem,
): boolean {
  return chatOutboxOwner(host).admit(host, captured, item) === "admitted";
}
