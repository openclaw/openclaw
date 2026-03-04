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
  const slackChannelId = params.context.ChannelId?.trim();
  const to = params.context.To?.trim();
  return {
    currentChannelId: to?.startsWith("channel:") ? to.slice("channel:".length) : slackChannelId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
