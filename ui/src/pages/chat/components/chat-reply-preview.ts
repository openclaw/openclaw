// Reply-preview resolution: memoized quoted-source previews served from
// already-loaded transcript rows first, then the reply-message access loader.
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { DEFAULT_AGENT_ID } from "../../../lib/sessions/session-key.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { prepareChatMessageRender, resolveMessageReplyText } from "./chat-message-markdown.ts";
import { projectMessageMedia } from "./chat-message-media.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import type { LoadedReplySource, ReplyPreview } from "./chat-reply-preview.types.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

type ResolvedReplyPreview = ReplyPreview | undefined;
type ReplyPreviewProps = Omit<
  Parameters<typeof resolveAssistantDisplayAvatar>[0],
  "assistantAvatar"
> & {
  assistantAvatar?: string | null;
  assistantName: string;
  userId?: string | null;
  userName?: string | null;
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  replyMessageAccess?: { read: (messageId: string) => unknown };
};

function projectResolvedReplyPreview(
  message: unknown,
  replyToId: string,
  props: ReplyPreviewProps,
  loaded?: LoadedReplySource,
): ResolvedReplyPreview {
  const { normalizedMessage: normalized, displayMarkdown } = prepareChatMessageRender(message);
  const text = resolveMessageReplyText(message, normalized, displayMarkdown);
  if (!text) {
    return undefined;
  }
  const group = {
    ...normalized,
    messages: [{ message }],
  };
  const sourceMessageId = persistedMessageEntryId(message) ?? replyToId;
  const senderLabel = loaded?.senderLabel ?? resolveMessageGroupSenderLabel(group, props);
  const isAssistant = normalizeRoleForGrouping(normalized.role) === "assistant";
  const agentId = normalized.senderSession?.agentId ?? props.currentAgentId ?? DEFAULT_AGENT_ID;
  const isCurrentAgent = agentId === (props.currentAgentId ?? DEFAULT_AGENT_ID);
  return {
    messageId: loaded?.messageId ?? sourceMessageId,
    sourceMessageId: loaded ? replyToId : sourceMessageId,
    senderLabel,
    sender: isAssistant
      ? {
          ...normalized.sender,
          name: senderLabel,
          identity: normalized.sender?.identity ?? { type: "agent", id: agentId },
        }
      : normalized.sender,
    ...(isAssistant
      ? {
          agentAvatar: resolveAssistantDisplayAvatar({
            currentAgentId: agentId,
            agents: props.agents,
            assistantAvatar: isCurrentAgent ? (props.assistantAvatar ?? null) : null,
            assistantAvatarUrl: isCurrentAgent
              ? props.assistantAvatarUrl
              : props.senderAgentAvatars?.get(agentId),
          }),
        }
      : {}),
    isLoaded: Boolean(loaded),
    isAttachment: !displayMarkdown,
    isImage: !displayMarkdown && projectMessageMedia(message, normalized.content).images.length > 0,
    text,
  };
}

export function createReplyPreviewResolver(
  loadedReplySources: ReadonlyMap<string, LoadedReplySource>,
  props: ReplyPreviewProps,
): (replyToId: string) => ResolvedReplyPreview {
  const resolved = new Map<string, ResolvedReplyPreview>();
  return (replyToId) => {
    if (resolved.has(replyToId)) {
      return resolved.get(replyToId);
    }
    const loaded = loadedReplySources.get(replyToId);
    const loadedPreview = loaded
      ? projectResolvedReplyPreview(loaded.message, replyToId, props, loaded)
      : undefined;
    if (loadedPreview) {
      resolved.set(replyToId, loadedPreview);
      return loadedPreview;
    }
    const message = props.replyMessageAccess?.read(replyToId);
    const preview = message ? projectResolvedReplyPreview(message, replyToId, props) : undefined;
    resolved.set(replyToId, preview);
    return preview;
  };
}
