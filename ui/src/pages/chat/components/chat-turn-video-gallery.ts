import type { ChatItem, MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { chatItemStartsUserTurn, hasForwardedSource } from "../chat-turn-boundary.ts";

export type TurnVideoMessage = { key: string; message: unknown };

/** Membership is projected before run frames/collapsed work, never from mounted DOM rows. */
export function projectTurnVideoMessages(items: readonly (ChatItem | MessageGroup)[]) {
  const byMessage = new Map<string, readonly TurnVideoMessage[]>();
  let turn: TurnVideoMessage[] = [];
  for (const item of items) {
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
      const message = {
        key: item.key,
        message: { role: "assistant", content: [{ type: "text", text: item.text }] },
      };
      turn.push(message);
      byMessage.set(item.key, turn);
    }
  }
  return byMessage;
}
