import {
  agentRunFrameGroups,
  coalesceAgentRunFrames,
  persistedMessageEntryId,
  setExpansionState,
} from "../chat-thread.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-group.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

export function projectTranscriptMessageIndex(
  transcriptItems: readonly ChatRenderItem[],
  expandedToolCards: Map<string, boolean>,
  props: Pick<ChatThreadProps, "assistantName" | "userId" | "userName" | "replyMessageAccess">,
  loadedReplySources: Map<string, LoadedReplySource>,
) {
  const messageRowKeysById = new Map<string, string>();
  const transcriptMessageKeys = new Map<string, string>();
  const expandReplyTargetWork = (messageId: string) => {
    for (const item of transcriptItems) {
      const parts = item.kind === "agent-run-frame" ? item.parts : [item];
      for (const part of parts) {
        if (
          part.kind === "work-group" &&
          part.groups.some((group) =>
            group.messages.some((source) => persistedMessageEntryId(source.message) === messageId),
          )
        ) {
          setExpansionState(expandedToolCards, part.key, true);
        }
      }
    }
  };
  const replyNavigationId = props.replyMessageAccess?.navigationId;
  if (replyNavigationId) {
    expandReplyTargetWork(replyNavigationId);
  }
  for (const item of transcriptItems) {
    const groups =
      item.kind === "agent-run-frame"
        ? agentRunFrameGroups(item)
        : item.kind === "group"
          ? [item]
          : item.kind === "work-group"
            ? item.groups
            : [];
    const firstGroup = groups.find((group) => group.role === "assistant") ?? groups[0];
    if (!firstGroup) {
      continue;
    }
    const senderLabel = resolveMessageGroupSenderLabel(firstGroup, {
      assistantName: props.assistantName,
      userId: props.userId,
      userName: props.userName,
    });
    for (const group of groups) {
      const rowKey =
        item.kind === "work-group" && expandedToolCards.get(item.key)
          ? `${item.key}:${group.key}`
          : item.key;
      for (const source of group.messages) {
        transcriptMessageKeys.set(source.key, rowKey);
        const sourceMessageId = persistedMessageEntryId(source.message);
        // The preview resolves content lazily; indexing only needs persisted identities.
        if (sourceMessageId) {
          messageRowKeysById.set(sourceMessageId, rowKey);
          loadedReplySources.set(sourceMessageId, {
            message: source.message,
            messageId: source.key,
            senderLabel,
          });
        }
      }
    }
  }
  return { messageRowKeysById, transcriptMessageKeys, expandReplyTargetWork };
}
