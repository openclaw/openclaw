import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { resolveMessageVisibleContent } from "../../../lib/chat/message-visibility.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

type ChatPositionMarker = {
  id: string;
  role: "user" | "assistant";
  anchorId: string;
  message: unknown;
};

export type ChatPositionIndex = {
  markers: ChatPositionMarker[];
  /** Transcript order, including continuations after an intervening user steer. */
  markerIdsByMessageId: Map<string, string>;
};

type RenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

function hasPositionContent(message: unknown): boolean {
  const { normalizedMessage, displayMarkdown } = prepareChatMessageRender(message);
  return (
    resolveMessageVisibleContent(message, normalizedMessage) === "non-text" ||
    Boolean(displayMarkdown.trim())
  );
}

export function projectChatPositions(
  items: readonly RenderItem[],
  expandedWork: ReadonlyMap<string, boolean>,
  messageRowKeysById: Map<string, string>,
): ChatPositionIndex {
  const markers = new Map<string, ChatPositionMarker>();
  const markerIdsByMessageId = new Map<string, string>();
  const add = (
    id: string,
    role: ChatPositionMarker["role"],
    messageId: string,
    message: unknown,
    rowKey: string,
  ) => {
    const marker = markers.get(id);
    if (marker) {
      marker.message = message;
    } else {
      markers.set(id, { id, role, anchorId: messageId, message });
    }
    markerIdsByMessageId.set(messageId, id);
    messageRowKeysById.set(messageId, rowKey);
  };
  const group = (item: MessageGroup, rowKey: string) => {
    if ((item.role !== "user" && item.role !== "assistant") || item.visibleContent === "none") {
      return;
    }
    for (const source of item.messages) {
      if (!hasPositionContent(source.message)) {
        continue;
      }
      const messageId = persistedMessageEntryId(source.message) ?? source.key;
      // A run can span frames, search matches, or a history page missing its user boundary.
      // Without run identity, retain the transcript's existing group boundary.
      const markerId =
        item.role === "user"
          ? messageId
          : item.runId
            ? `run:${item.runId}`
            : (persistedMessageEntryId(item.messages[0]?.message) ?? item.key);
      add(markerId, item.role, messageId, source.message, rowKey);
    }
  };
  const visit = (item: RenderItem, rowKey: string) => {
    if (item.kind === "group") {
      group(item, rowKey);
    } else if (item.kind === "agent-run-frame") {
      for (const part of item.parts) {
        visit(part, rowKey);
      }
    } else if (item.kind === "activity-run") {
      for (const part of item.groups) {
        group(part, rowKey);
      }
    } else if (item.kind === "work-group" && expandedWork.get(item.key)) {
      // Folded work has no mounted bubble to reveal. Its visible final reply owns the anchor.
      for (const part of item.groups) {
        group(part, rowKey === item.key ? `${item.key}:${part.key}` : rowKey);
      }
    } else if (item.kind === "stream-run") {
      for (const part of item.parts) {
        if (part.kind !== "stream") {
          continue;
        }
        const message = {
          role: "assistant",
          content: [{ type: "text", text: part.text }],
          timestamp: part.startedAt,
        };
        if (!hasPositionContent(message)) {
          continue;
        }
        add(item.runId ? `run:${item.runId}` : item.key, "assistant", part.key, message, rowKey);
      }
    }
  };
  for (const item of items) {
    visit(item, item.key);
  }
  return { markers: [...markers.values()], markerIdsByMessageId };
}
