import { createReplyPrefixContext, createReplyPrefixOptions, type ReplyPrefixContextBundle, type ReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks, type CreateTypingCallbacksParams, type TypingCallbacks } from "../channels/typing.js";
import type { ReplyPayload } from "./reply-payload.js";
export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };
export type ChannelReplyPipeline = ReplyPrefixOptions & {
    typingCallbacks?: TypingCallbacks;
    transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};
export declare function createChannelReplyPipeline(params: {
    cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
    agentId: string;
    channel?: string;
    accountId?: string;
    typing?: CreateTypingCallbacksParams;
    typingCallbacks?: TypingCallbacks;
    transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
}): ChannelReplyPipeline;
