import { registerListener } from "../../../../src/shared/listeners.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";

type Host = { chatQueue: ChatQueueItem[] };
const listeners = new WeakMap<Host, Set<() => void>>();

/** Queue presentation follows its host across Gateway ownership changes. */
export function subscribeChatOutboxQueue(host: Host, notify: () => void): () => void {
  let subscribers = listeners.get(host);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(host, subscribers);
  }
  return registerListener(subscribers, notify);
}

export function publishChatOutboxQueue(host: Host): void {
  for (const notify of listeners.get(host) ?? []) {
    notify();
  }
}

/** Publish the owner's rows without cloning them or deferring reads. */
export function replaceChatOutboxQueue(host: Host, queue: ChatQueueItem[], notify = true): void {
  host.chatQueue = queue;
  if (notify) {
    publishChatOutboxQueue(host);
  }
}
