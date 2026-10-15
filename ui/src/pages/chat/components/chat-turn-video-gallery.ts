import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { getChatItemsGeneration } from "../chat-thread.ts";
import { chatItemStartsUserTurn, hasForwardedSource } from "../chat-turn-boundary.ts";

export type TurnVideoMessage = { key: string; message: unknown };

type CachedTurnVideoMessages = {
  generation: number;
  byMessage: Map<string, readonly TurnVideoMessage[]>;
  live?: { index: number; turn: TurnVideoMessage[]; slot: number; text: string };
};

const turnVideosByItems = new WeakMap<
  readonly (ChatItem | MessageGroup)[],
  CachedTurnVideoMessages
>();

function streamMessage(item: Extract<ChatItem, { kind: "stream" }>): TurnVideoMessage {
  return {
    key: item.key,
    message: { role: "assistant", content: [{ type: "text", text: item.text }] },
  };
}

/** Membership is projected before run frames/collapsed work, never from mounted DOM rows. */
export function projectTurnVideoMessages(items: readonly (ChatItem | MessageGroup)[]) {
  const generation = getChatItemsGeneration(items);
  const cached = turnVideosByItems.get(items);
  if (cached?.generation === generation) {
    const live = cached.live;
    const item = live ? items[live.index] : undefined;
    if (live && item?.kind === "stream" && live.text !== item.text) {
      // Gallery expansion reads this live lookup lazily. Replace the synthetic
      // message so previously prepared immutable message snapshots stay valid.
      live.turn[live.slot] = streamMessage(item);
      live.text = item.text;
    }
    return cached.byMessage;
  }
  const byMessage = new Map<string, readonly TurnVideoMessage[]>();
  const projection: CachedTurnVideoMessages = { generation, byMessage };
  let turn: TurnVideoMessage[] = [];
  for (const [index, item] of items.entries()) {
    if (
      item.kind === "divider" ||
      chatItemStartsUserTurn(item) ||
      (item.kind === "group" && hasForwardedSource(item))
    ) {
      turn = [];
    }
    if (item.kind === "group") {
      if (normalizeRoleForGrouping(item.role) !== "assistant" || hasForwardedSource(item)) {
        continue;
      }
      for (const message of item.messages) {
        turn.push(message);
        byMessage.set(message.key, turn);
      }
    } else if (item.kind === "stream") {
      if (item.isStreaming) {
        projection.live = { index, turn, slot: turn.length, text: item.text };
      }
      turn.push(streamMessage(item));
      byMessage.set(item.key, turn);
    }
  }
  turnVideosByItems.set(items, projection);
  return byMessage;
}
