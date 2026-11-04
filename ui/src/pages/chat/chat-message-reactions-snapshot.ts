import type { MessageReactionSummary } from "@openclaw/gateway-protocol";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";

export function projectChatMessageReactions(
  messages: readonly unknown[],
  reactions: ReadonlyMap<string, MessageReactionSummary[]>,
): Record<string, MessageReactionSummary[]> {
  const retained = new Map<string, MessageReactionSummary[]>();
  for (const message of messages) {
    const id = readChatThreadMessageIdentity(message)?.id;
    const summaries = id ? reactions.get(id) : undefined;
    if (id && summaries?.length) {
      retained.set(id, summaries);
    }
  }
  return Object.fromEntries(retained);
}
