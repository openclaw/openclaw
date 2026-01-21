import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveSlackAccount } from "./accounts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const configuredReplyToMode =
    resolveSlackAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    }).replyToMode ?? "off";
  const effectiveReplyToMode = params.context.ThreadLabel ? "all" : configuredReplyToMode;
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
