import { AsyncLocalStorage } from "node:async_hooks";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

export type ReplyDispatchHookContext = {
  sessionKey: string;
  channelId: string;
  to: string;
  accountId?: string;
  isGroup?: boolean;
  groupId?: string;
};

const replyDispatchHookContextStorage = new AsyncLocalStorage<ReplyDispatchHookContext | undefined>();

export function runWithReplyDispatchHookContext<T>(
  context: ReplyDispatchHookContext | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return replyDispatchHookContextStorage.run(context, run);
}

export function getReplyDispatchHookContext(): ReplyDispatchHookContext | undefined {
  return replyDispatchHookContextStorage.getStore();
}

export function deriveReplyDispatchHookContext(
  ctx: FinalizedMsgContext,
): ReplyDispatchHookContext | undefined {
  const sessionKey = typeof ctx.SessionKey === "string" ? ctx.SessionKey.trim() : "";
  const channelId = normalizeMessageChannel(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const toCandidate =
    typeof ctx.OriginatingTo === "string"
      ? ctx.OriginatingTo
      : typeof ctx.To === "string"
        ? ctx.To
        : typeof ctx.From === "string"
          ? ctx.From
          : "";
  const to = toCandidate.trim();
  if (!sessionKey || !channelId || !to) {
    return undefined;
  }
  const isGroup = Boolean(ctx.GroupSubject || ctx.GroupChannel);
  return {
    sessionKey,
    channelId,
    to,
    ...(ctx.AccountId ? { accountId: ctx.AccountId } : {}),
    ...(isGroup ? { isGroup: true, groupId: to } : {}),
  };
}
