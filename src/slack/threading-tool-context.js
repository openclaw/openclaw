import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";
export function buildSlackThreadingToolContext(params) {
    const account = resolveSlackAccount({
        cfg: params.cfg,
        accountId: params.accountId,
    });
    const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
    const hasExplicitThreadTarget = params.context.MessageThreadId != null;
    const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
    const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
    return {
        currentChannelId: params.context.To?.startsWith("channel:")
            ? params.context.To.slice("channel:".length)
            : undefined,
        currentThreadTs: threadId != null ? String(threadId) : undefined,
        replyToMode: effectiveReplyToMode,
        hasRepliedRef: params.hasRepliedRef,
    };
}
