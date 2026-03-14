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
  // currentChannelId uses the native channel ID ("D…" for DMs, raw "C…" for channels)
  // so that Slack actions like react/read/edit/delete/pins can infer the correct target.
  // For DMs, currentDmUserId stores the "user:<id>" address separately so that
  // resolveSlackAutoThreadId can match message-tool sends that target the same DM user.
  const currentChannelId = to?.startsWith("channel:")
    ? to.slice("channel:".length)
    : params.context.NativeChannelId?.trim() || undefined;
  const currentDmUserId = to?.startsWith("user:") ? to : undefined;
  return {
    currentChannelId,
    currentDmUserId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
