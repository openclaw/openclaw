import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { hasVisiblePreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import {
  assistantMessageCanOwnTurnActions,
  assistantMessageIsInterrupted,
  assistantMessageKind,
} from "./chat-assistant-reply.ts";
import {
  groupPreparedChatMessages,
  type ReplyAttributionContext,
} from "./chat-thread-grouping-data.ts";
import type { ChatReasoning } from "./tool-stream-contract.ts";

export type {
  ReplyAttributionContext,
  ReplyAttributionFacts,
} from "./chat-thread-grouping-data.ts";

// The data algorithm receives presentation policy; importing it never loads the UI.
const preparation = {
  resolveMessageDisplayMarkdown,
  hasVisiblePreparedActivity,
  assistantMessageCanOwnTurnActions,
  assistantMessageIsInterrupted,
  assistantMessageKind,
};

export function groupMessages(
  items: ChatItem[],
  replyContext: ReplyAttributionContext = {},
  reasoning?: ChatReasoning | null,
  showReasoning = false,
) {
  return groupPreparedChatMessages(items, preparation, replyContext, reasoning, showReasoning);
}
