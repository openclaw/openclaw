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
  const { incomingThreadTs, messageTs, isThreadReply } = resolveSlackThreadContext(params);
  // Only use incomingThreadTs for threading when it's a genuine thread reply.
  // For auto-created thread_ts (e.g. Slack "Agents & AI Apps"), respect
  // replyToMode so that "off" keeps replies in the main channel.
  const replyThreadTs = isThreadReply
    ? incomingThreadTs
    : params.replyToMode === "off"
      ? undefined
      : (incomingThreadTs ?? (params.replyToMode === "all" ? messageTs : undefined));
  const statusThreadTs = replyThreadTs ?? messageTs;
  return { replyThreadTs, statusThreadTs };
}
