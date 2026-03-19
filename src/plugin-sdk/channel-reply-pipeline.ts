import {
  createReplyPrefixOptions,
  type ReplyPrefixContextBundle,
  type ReplyPrefixOptions,
} from "../channels/reply-prefix.js";
import {
  createTypingCallbacks,
  type CreateTypingCallbacksParams,
  type TypingCallbacks,
} from "../channels/typing.js";

export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };

export type ChannelReplyPipeline = ReplyPrefixOptions & {
  typingCallbacks?: TypingCallbacks;
};

export function createChannelReplyPipeline(params: {
  cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
  agentId: string;
  channel?: string;
  accountId?: string;
  typing?: CreateTypingCallbacksParams;
  typingCallbacks?: TypingCallbacks;
}): ChannelReplyPipeline {
  return {
    ...createReplyPrefixOptions({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId,
    }),
    ...(params.typingCallbacks
      ? { typingCallbacks: params.typingCallbacks }
      : params.typing
        ? { typingCallbacks: createTypingCallbacks(params.typing) }
        : {}),
  };
}
