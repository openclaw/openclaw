import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches, type SessionScopeHost } from "../../lib/sessions/index.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  appendChatMessageToCache,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

type QueuedUserTurnHost = SessionScopeHost & {
  sessionKey: string;
  chatMessages: unknown[];
  chatMessagesBySession?: ChatMessageCache;
};

function queuedUserTurnIdempotencyKeys(item: ChatQueueItem): string[] {
  return item.sendRunId ? [item.sendRunId, `${item.sendRunId}:user`] : [];
}

export function chatMessagesContainQueuedUserTurn(
  messages: readonly unknown[],
  item: ChatQueueItem,
): boolean {
  const idempotencyKeys = queuedUserTurnIdempotencyKeys(item);
  if (idempotencyKeys.length === 0) {
    return false;
  }
  return messages.some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return false;
    }
    const marker = (message as { __openclaw?: unknown })["__openclaw"];
    const idempotencyKey =
      marker && typeof marker === "object" && !Array.isArray(marker)
        ? (marker as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    return typeof idempotencyKey === "string" && idempotencyKeys.includes(idempotencyKey);
  });
}

function durableDeliveredAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  return attachments?.flatMap((attachment) => {
    // Composer uploads keep their bytes in the payload store; queue rows carry
    // metadata only. Resolve through the store or attachment-only turns
    // materialize empty and vanish at chip retirement.
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (!dataUrl) {
      return [];
    }
    // Terminal retirement releases the queue-owned live blob. Pin synthetic
    // transcript content to durable bytes before that ownership ends.
    return [{ ...attachment, dataUrl, previewUrl: dataUrl }];
  });
}

export function preserveQueuedUserTurn(state: QueuedUserTurnHost, item: ChatQueueItem): void {
  const runId = item.sendRunId;
  const sessionKey = item.sessionKey ?? state.sessionKey;
  if (!runId) {
    return;
  }
  const content = buildUserChatMessageContentBlocks(
    item.text,
    durableDeliveredAttachments(item.attachments),
  );
  if (!content.length) {
    return;
  }
  const userMessage = {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: { idempotencyKey: `${runId}:user` },
  };
  if (visibleSessionMatches(state, sessionKey, item.agentId)) {
    if (!chatMessagesContainQueuedUserTurn(state.chatMessages, item)) {
      state.chatMessages = [...state.chatMessages, userMessage];
    }
    return;
  }
  if (!state.chatMessagesBySession) {
    return;
  }
  const target = { sessionKey, agentId: item.agentId };
  const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, target);
  if (!chatMessagesContainQueuedUserTurn(cached, item)) {
    appendChatMessageToCache(state.chatMessagesBySession, state, target, userMessage);
  }
}

export function preserveSteeredQueueItemsForRun(
  state: QueuedUserTurnHost & { chatQueue: ChatQueueItem[] },
  runId: string | undefined,
): void {
  if (!runId) {
    return;
  }
  for (const item of state.chatQueue) {
    // sendState marks an in-flight steer whose chat.send has not been
    // acknowledged; materializing it here would leave a phantom user turn if
    // the Gateway rejects the send.
    if (item.kind === "steered" && item.pendingRunId === runId && !item.sendState) {
      preserveQueuedUserTurn(state, item);
    }
  }
}
