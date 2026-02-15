import type { ReplyToMode } from "../config/types.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "./types.js";

export type SlackThreadContext = {
  incomingThreadTs?: string;
  messageTs?: string;
  isThreadReply: boolean;
  replyToId?: string;
  messageThreadId?: string;
};

export function resolveSlackThreadContext(params: {
  message: SlackMessageEvent | SlackAppMentionEvent;
  replyToMode: ReplyToMode;
}): SlackThreadContext {
  const incomingThreadTs = params.message.thread_ts;
  const eventTs = params.message.event_ts;
  const messageTs = params.message.ts ?? eventTs;
  const hasThreadTs = typeof incomingThreadTs === "string" && incomingThreadTs.length > 0;
  const isThreadReply =
    hasThreadTs && (incomingThreadTs !== messageTs || Boolean(params.message.parent_user_id));
  const replyToId = incomingThreadTs ?? messageTs;
  const messageThreadId = isThreadReply
    ? incomingThreadTs
    : params.replyToMode === "all"
      ? messageTs
      : undefined;
  return {
    incomingThreadTs,
    messageTs,
    isThreadReply,
    replyToId,
    messageThreadId,
  };
}

export function resolveSlackThreadTargets(params: {
  message: SlackMessageEvent | SlackAppMentionEvent;
  replyToMode: ReplyToMode;
}) {
  const { incomingThreadTs, messageTs } = resolveSlackThreadContext(params);
  const replyThreadTs = incomingThreadTs ?? (params.replyToMode === "all" ? messageTs : undefined);
  // Don't fall back to messageTs for status indicators when threading is off —
  // posting the typing status as a reply to the user's message creates a Slack
  // thread even though the user disabled threading.  (#16868)
  const statusThreadTs = replyThreadTs;
  return { replyThreadTs, statusThreadTs };
}
