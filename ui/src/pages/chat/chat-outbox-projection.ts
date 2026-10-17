import { getObserver } from "@solidjs/signals";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { subscribeChatOutboxQueue } from "./chat-outbox-queue.ts";

/** Track outbox publication without changing synchronous queue reads or row identity. */
export function projectChatOutboxQueue<T extends Parameters<typeof subscribeChatOutboxQueue>[0]>(
  state: T,
): T {
  let value: ChatQueueItem[] = state.chatQueue;
  const queue = projectSource(state, {
    read: () => value,
    subscribe: subscribeChatOutboxQueue,
    equality: "revision",
  });
  Object.defineProperty(state, "chatQueue", {
    configurable: true,
    enumerable: true,
    get: () => (getObserver() ? queue.read() : value),
    set: (next: ChatQueueItem[]) => {
      value = next;
    },
  });
  return state;
}
