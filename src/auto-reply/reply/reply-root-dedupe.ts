import { normalizeChannelId } from "../../channels/plugins/index.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { FinalizedMsgContext, MsgContext, TemplateContext } from "../templating.js";
import type { FollowupRun, ReplyRootSource } from "./queue/types.js";

const RECENT_SENT_REPLY_ROOTS_KEY = Symbol.for("openclaw.recentSentReplyRoots");
const RECENT_SENT_REPLY_ROOTS = resolveGlobalSingleton(RECENT_SENT_REPLY_ROOTS_KEY, () =>
  createDedupeCache({
    ttlMs: 2 * 60 * 1000,
    maxSize: 10_000,
  }),
);

type ReplyRootIdentityParams = {
  rootMessageId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  messageId?: string;
  messageIdFull?: string;
};

type ReplyRootRouteKeyParams = {
  scopeKey?: string;
  agentId?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number | null;
  replyRootId?: string;
  replyRootSource?: ReplyRootSource;
};

export type ResolvedReplyRoot = {
  id: string;
  source: ReplyRootSource;
};

function clean(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeReplyRootChannel(value: string | undefined | null): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) {
    return undefined;
  }
  return normalizeChannelId(cleaned) ?? cleaned.toLowerCase();
}

export function resolveReplyRoot(params: ReplyRootIdentityParams): ResolvedReplyRoot | undefined {
  const replyToId = clean(params.replyToIdFull) ?? clean(params.replyToId);
  if (replyToId) {
    return { id: replyToId, source: "reply-to" };
  }
  const rootMessageId = clean(params.rootMessageId);
  if (rootMessageId) {
    return { id: rootMessageId, source: "thread-root" };
  }
  const messageId = clean(params.messageIdFull) ?? clean(params.messageId);
  if (messageId) {
    return { id: messageId, source: "message-id" };
  }
  return undefined;
}

export function resolveReplyRootId(params: ReplyRootIdentityParams): string | undefined {
  return resolveReplyRoot(params)?.id;
}

export function resolveReplyRootFromContext(
  ctx: Pick<
    MsgContext | TemplateContext | FinalizedMsgContext,
    "RootMessageId" | "ReplyToId" | "ReplyToIdFull" | "MessageSid" | "MessageSidFull"
  >,
): ResolvedReplyRoot | undefined {
  return resolveReplyRoot({
    rootMessageId: ctx.RootMessageId,
    replyToId: ctx.ReplyToId,
    replyToIdFull: ctx.ReplyToIdFull,
    messageId: ctx.MessageSid,
    messageIdFull: ctx.MessageSidFull,
  });
}

export function resolveReplyRootIdFromContext(
  ctx: Pick<
    MsgContext | TemplateContext | FinalizedMsgContext,
    "RootMessageId" | "ReplyToId" | "ReplyToIdFull" | "MessageSid" | "MessageSidFull"
  >,
): string | undefined {
  return resolveReplyRootFromContext(ctx)?.id;
}

export function buildRecentSentReplyRootKey(params: ReplyRootRouteKeyParams): string | undefined {
  const replyRootId = clean(params.replyRootId);
  if (!replyRootId || params.replyRootSource === "thread-root") {
    return undefined;
  }
  return JSON.stringify([
    "sent-reply-root",
    params.scopeKey ?? "",
    params.agentId ?? "",
    normalizeReplyRootChannel(params.channel) ?? "",
    params.to ?? "",
    params.accountId ?? "",
    params.threadId == null ? "" : String(params.threadId),
    replyRootId,
  ]);
}

export function buildRecentSentReplyRootKeyForRun(
  run: Pick<
    FollowupRun,
    | "originatingChannel"
    | "originatingTo"
    | "originatingAccountId"
    | "originatingThreadId"
    | "replyRootId"
    | "replyRootSource"
    | "run"
  >,
): string | undefined {
  return buildRecentSentReplyRootKey({
    scopeKey: run.run.sessionKey ?? run.run.sessionId,
    agentId: run.run.agentId,
    channel: run.originatingChannel,
    to: run.originatingTo,
    accountId: run.originatingAccountId,
    threadId: run.originatingThreadId,
    replyRootId: run.replyRootId,
    replyRootSource: run.replyRootSource,
  });
}

export function hasRecentSentReplyRoot(key: string | undefined): boolean {
  return Boolean(key && RECENT_SENT_REPLY_ROOTS.peek(key));
}

export function markRecentSentReplyRoot(key: string | undefined): void {
  if (!key) {
    return;
  }
  RECENT_SENT_REPLY_ROOTS.check(key);
}

export function resetRecentSentReplyRootDedupe(): void {
  RECENT_SENT_REPLY_ROOTS.clear();
}
