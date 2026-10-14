// Reply-preview resolution: memoized quoted-source previews served from
// already-loaded transcript rows first, then page-carried quoted originals.
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { DEFAULT_AGENT_ID } from "../../../lib/sessions/session-key.ts";
import { userTurnRunId } from "../chat-thread-items.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { prepareChatMessageRender, resolveMessageReplyText } from "./chat-message-markdown.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import type { ReplyPreview, ReplyPreviewLookup } from "./chat-reply-preview.types.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

export type LoadedReplySource = {
  message: unknown;
  messageId: string;
  senderLabel: string;
};

/**
 * How the Gateway answered a lookup without a message: not yet (`pending`), the
 * original is inaccessible (`missing`), or it exists but is too large (`oversized`).
 */
export type ReplyMessageStatus = "pending" | "missing" | "oversized";

const STATUS_PREVIEWS = {
  pending: { pending: true },
  missing: { missing: true },
  oversized: { oversized: true },
} as const;

type ReplyPreviewProps = Omit<
  Parameters<typeof resolveAssistantDisplayAvatar>[0],
  "assistantAvatar"
> & {
  assistantAvatar?: string | null;
  assistantName: string;
  userId?: string | null;
  userName?: string | null;
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  // The thread's full accessor passes through; only read and status are used.
  replyMessageAccess?: {
    read: (messageId: string) => unknown;
    status?: (messageId: string) => ReplyMessageStatus | undefined;
    [key: string]: unknown;
  };
};

function projectResolvedReplyPreview(
  message: unknown,
  replyToId: string,
  props: ReplyPreviewProps,
  loaded?: LoadedReplySource,
): ReplyPreview | undefined {
  const { normalizedMessage: normalized, displayMarkdown } = prepareChatMessageRender(message);
  const text = resolveMessageReplyText(message, normalized, displayMarkdown);
  const persistedId = persistedMessageEntryId(message);
  // A persisted original names its author even when it has no text (image-only, etc.).
  if (!text && !persistedId) {
    return undefined;
  }
  const group = {
    ...normalized,
    messages: [{ message }],
  };
  const sourceMessageId = persistedId ?? replyToId;
  const isAssistant = normalizeRoleForGrouping(normalized.role) === "assistant";
  // Another agent's original reaches this session only with its session
  // provenance; transcript sender metadata never carries an agent identity.
  // Only an original without that provenance is the viewing agent's own.
  const agentId = normalized.senderSession?.agentId ?? props.currentAgentId ?? DEFAULT_AGENT_ID;
  const isCurrentAgent = agentId === (props.currentAgentId ?? DEFAULT_AGENT_ID);
  // Another agent's original is named by that agent, never by the viewing
  // agent's name; an agent without a display name leaves the author unknown.
  const senderLabel =
    isAssistant && !isCurrentAgent
      ? normalized.senderLabel?.trim() ||
        props.agents?.find((agent) => agent.id === agentId)?.identity?.name?.trim() ||
        null
      : (loaded?.senderLabel ?? resolveMessageGroupSenderLabel(group, props));
  return {
    messageId: loaded?.messageId ?? sourceMessageId,
    sourceMessageId: loaded ? replyToId : sourceMessageId,
    senderLabel,
    sender: isAssistant
      ? {
          ...normalized.sender,
          ...(senderLabel ? { name: senderLabel } : {}),
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
      : { turnRunId: userTurnRunId(message) ?? undefined }),
    text,
  };
}

export function createReplyPreviewResolver(
  loadedReplySources: ReadonlyMap<string, LoadedReplySource>,
  props: ReplyPreviewProps,
): ReplyPreviewLookup {
  const resolved = new Map<string, ReturnType<ReplyPreviewLookup>>();
  return (replyToId) => {
    if (resolved.has(replyToId)) {
      return resolved.get(replyToId);
    }
    const loaded = loadedReplySources.get(replyToId);
    const message = loaded?.message ?? props.replyMessageAccess?.read(replyToId);
    const status = message ? undefined : props.replyMessageAccess?.status?.(replyToId);
    const preview = message
      ? projectResolvedReplyPreview(message, replyToId, props, loaded)
      : status && STATUS_PREVIEWS[status];
    resolved.set(replyToId, preview);
    return preview;
  };
}
