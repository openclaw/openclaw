import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
  const hasExplicitThreadTarget = params.context.MessageThreadId != null;
  const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
  const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
  // For channel targets, strip the "channel:" prefix to get the raw channel ID.
  // For DM targets (user:xxx), preserve the full "user:xxx" address so that
  // resolveSlackAutoThreadId can match it when the message tool targets the same DM.
  // NativeChannelId ("D…") is available for reaction APIs but currentChannelId must
  // use "user:xxx" form so the thread-injection comparison in resolveSlackAutoThreadId
  // (which builds targetAddress as `user:${id}` for user-kind targets) finds a match.
  const to = params.context.To;
  const currentChannelId = to?.startsWith("channel:")
    ? to.slice("channel:".length)
    : to?.startsWith("user:")
      ? to // e.g. "user:U0AC3LBA08M" — preserved for DM thread matching
      : params.context.NativeChannelId?.trim() || undefined;
  return {
    currentChannelId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
