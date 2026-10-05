import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";

export const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
export const resolveSessionTargetStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionTarget"]
> = ({ kind, id, threadId }) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);
