import { createMemo } from "solid-js";
import type { ChatReplyTarget } from "../../lib/chat/chat-types.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";
import type { ChatProps } from "./chat-view-frame.ts";
import { resolveComposerReplyLine, type ReplyLine } from "./components/chat-reply-attribution.ts";
import { createReplyPreviewResolver } from "./components/chat-reply-preview.ts";

type ComposerReplyLineProps = Omit<
  Parameters<typeof createReplyPreviewResolver>[1],
  "replyMessageAccess"
> & {
  messages: readonly unknown[];
  replyTarget?: ChatReplyTarget | null;
};

/** Names the composer's reply target through the transcript's own author projection. */
function resolveChatComposerReplyLine(props: ComposerReplyLineProps): ReplyLine | null {
  const target = props.replyTarget;
  if (!target) {
    return null;
  }
  const id = target.sourceMessageId;
  // Replies usually target recent rows; search from the newest.
  const source = id
    ? props.messages.findLast((message) => persistedMessageEntryId(message) === id)
    : undefined;
  const lookup = createReplyPreviewResolver(new Map(), {
    ...props,
    replyMessageAccess: { read: (messageId) => (messageId === id ? source : undefined) },
  });
  return resolveComposerReplyLine(target, lookup, props.userId);
}

export function createChatComposerReplyLine(input: { props: ChatProps }) {
  return createMemo(() => {
    const props = input.props;
    return props.replyTarget
      ? resolveChatComposerReplyLine({
          replyTarget: props.replyTarget,
          messages: props.messages,
          assistantName: props.assistantName,
          assistantAvatar: props.assistantAvatar,
          assistantAvatarUrl: props.assistantAvatarUrl,
          assistantAvatarSource: props.assistantAvatarSource,
          currentAgentId: props.currentAgentId,
          userId: props.userId,
          userName: props.userName,
          senderAgentAvatars: props.senderAgentAvatars,
        })
      : null;
  });
}
