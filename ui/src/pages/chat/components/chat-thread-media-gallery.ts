import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { getChatItemsGeneration } from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";

export type ThreadMediaMessage = { key: string; message: unknown };

type CachedThreadMediaMessages = {
  generation: number;
  byMessage: Map<string, readonly ThreadMediaMessage[]>;
  live?: { index: number; messages: ThreadMediaMessage[]; slot: number; text: string };
};

const threadMediaByItems = new WeakMap<
  readonly (ChatItem | MessageGroup)[],
  CachedThreadMediaMessages
>();

function streamMessage(item: Extract<ChatItem, { kind: "stream" }>): ThreadMediaMessage {
  return {
    key: item.key,
    message: { role: "assistant", content: [{ type: "text", text: item.text }] },
  };
}

/** Membership is projected before run frames/collapsed work, never from mounted DOM rows. */
export function projectThreadMediaMessages(items: readonly (ChatItem | MessageGroup)[]) {
  const generation = getChatItemsGeneration(items);
  const cached = threadMediaByItems.get(items);
  if (cached?.generation === generation) {
    const live = cached.live;
    const item = live ? items[live.index] : undefined;
    if (live && item?.kind === "stream" && live.text !== item.text) {
      // Gallery expansion reads this live lookup lazily. Replace the synthetic
      // message so previously prepared immutable message snapshots stay valid.
      live.messages[live.slot] = streamMessage(item);
      live.text = item.text;
    }
    return cached.byMessage;
  }
  const byMessage = new Map<string, readonly ThreadMediaMessage[]>();
  const projection: CachedThreadMediaMessages = { generation, byMessage };
  const messages: ThreadMediaMessage[] = [];
  for (const [index, item] of items.entries()) {
    if (item.kind === "group") {
      const role = normalizeRoleForGrouping(item.role);
      // Foreign-session media must not borrow the local thread source authority.
      if ((role !== "user" && role !== "assistant") || hasForwardedSource(item)) {
        continue;
      }
      for (const message of item.messages) {
        messages.push(message);
        byMessage.set(message.key, messages);
      }
    } else if (item.kind === "stream") {
      if (item.isStreaming) {
        projection.live = { index, messages, slot: messages.length, text: item.text };
      }
      messages.push(streamMessage(item));
      byMessage.set(item.key, messages);
    }
  }
  threadMediaByItems.set(items, projection);
  return byMessage;
}
