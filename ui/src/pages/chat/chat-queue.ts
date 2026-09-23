import { compareChatQueueOrder, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
import { scopedAgentIdForSession, type SessionScopeHost } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import type { StoredChatQueueReplacement } from "./composer-persistence-state.ts";
import {
  type ChatQueueAdmissionResult,
  listStoredChatOutboxes,
  storedChatOutboxScopeKey,
  type ChatComposerScope,
  type StoredChatOutbox,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";

type ChatQueueStoreHost = {
  chatQueue: ChatQueueItem[];
  chatAttachments?: ChatAttachment[];
  chatRunId?: string | null;
  chatSending?: boolean;
  chatSendingScopeKey?: string | null;
  requestUpdate?: () => void;
};
type ChatQueueSessionHost = ChatQueueStoreHost & ChatComposerScope & { sessionKey: string };
export type ChatQueueScopedSessionHost = ChatQueueSessionHost & SessionScopeHost;

export function isSteerableQueuedMessage(item: ChatQueueItem): boolean {
  return (
    isMovableChatQueueItem(item) &&
    (item.sendState === undefined || item.sendState === "waiting-idle") &&
    !item.localCommandName
  );
}

export function steerableQueuedMessage(queue: readonly ChatQueueItem[]): ChatQueueItem | undefined {
  return queue.toSorted(compareChatQueueOrder).find(isSteerableQueuedMessage);
}

export function isVolatileQueuedMessage(host: ChatQueueScopedSessionHost, id: string): boolean {
  return chatOutboxOwner(host).hasVolatile(host, id);
}

/** True while the row has a stored copy that would survive a reload. */
export function isDurableQueuedMessage(host: ChatQueueScopedSessionHost, id: string): boolean {
  return chatOutboxOwner(host).durable(host, id) !== undefined;
}

/**
 * Every pane sharing an outbox also shares its drain, and any of them can own the
 * drain lane. A fact one pane records about a row — a delivery hold, say — has to
 * be read across all of them, or the pane that drains will not see it. Panes
 * registered with an owner are the same kind of chat host as the caller.
 */
export function anyChatOutboxPaneMatches<T extends ChatQueueScopedSessionHost>(
  host: T,
  matches: (pane: T) => boolean,
): boolean {
  return matches(host) || chatOutboxOwner(host).anyPane((pane) => matches(pane as T));
}

export function keepVolatileQueuedMessage(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  item: ChatQueueItem,
  agentId?: string,
  options: { retryable?: boolean } = {},
): void {
  const scope = resolveUiConversationIdentity(host, sessionKey, agentId ?? item.agentId);
  chatOutboxOwner(host).keep(host, scope, item, options.retryable);
}

export function syncVisibleChatQueueProjection(
  host: ChatQueueScopedSessionHost,
  options: { requestUpdate?: boolean } = {},
): void {
  chatOutboxOwner(host).syncHost(host, options);
}

export function subscribeChatOutboxProjection(
  host: ChatQueueScopedSessionHost,
  onDiscard?: (item: ChatQueueItem) => void,
): () => void {
  return chatOutboxOwner(host).subscribe(host, onDiscard);
}

export function enqueueChatMessage(
  host: ChatQueueScopedSessionHost,
  text: string,
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
  sender?: SenderIdentity,
): ChatQueueItem | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const item: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    refreshSessions,
    localCommandArgs: localCommand?.args,
    localCommandName: localCommand?.name,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
    ...(sender ? { sender } : {}),
  };
  keepVolatileQueuedMessage(host, host.sessionKey, item, item.agentId);
  return item;
}

export function enqueuePendingRunMessage(
  host: ChatQueueScopedSessionHost,
  text: string,
  pendingRunId: string,
  sender?: SenderIdentity,
) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  // Local commands join an existing run without a wire chat.send, so this
  // pending row intentionally has no fake send identity.
  const item: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    pendingRunId,
    ...(sender ? { sender } : {}),
  };
  keepVolatileQueuedMessage(host, host.sessionKey, item);
}

export function readChatQueueForScope(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  agentId?: string,
): ChatQueueItem[] {
  const scope = resolveUiConversationIdentity(host, sessionKey, agentId);
  return chatOutboxOwner(host).snapshot(host, scope);
}

export function readQueuedMessageById(
  host: ChatQueueScopedSessionHost,
  id: string,
): ChatQueueItem | null {
  return chatOutboxOwner(host).locate(host, id)?.item ?? null;
}

export function updateVolatileQueuedMessage(
  host: ChatQueueScopedSessionHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
  options: { retryable?: boolean } = {},
): ChatQueueItem | null {
  return chatOutboxOwner(host).change(host, id, update, options.retryable);
}

export function updateQueuedMessage(
  host: ChatQueueScopedSessionHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return chatOutboxOwner(host).update(host, [{ id, update }])?.[0] ?? null;
}

/** Positive custody settles uncertainty, not consumption or retry-payload ownership. */
export function confirmQueuedMessageCustody(
  host: ChatQueueScopedSessionHost,
  expected: ChatQueueItem,
  sessionId: string | undefined,
): boolean {
  if (!sessionId || (expected.sessionId && expected.sessionId !== sessionId)) {
    return false;
  }
  const current = readQueuedMessageById(host, expected.id);
  if (
    !current ||
    (current.sessionId && current.sessionId !== sessionId) ||
    !sameQueuedDeliveryVersion(current, expected)
  ) {
    return false;
  }
  if (current.sessionId && current.sendState !== "unconfirmed") {
    return true;
  }
  return (
    updateQueuedMessage(host, expected.id, (item) => ({
      ...item,
      sessionId,
      ...(item.sendState === "unconfirmed"
        ? { sendState: "waiting-idle" as const, sendError: undefined }
        : {}),
    })) !== null
  );
}

export function updateQueuedMessagesForSession(
  host: ChatQueueScopedSessionHost,
  updates: readonly { id: string; update: (item: ChatQueueItem) => ChatQueueItem }[],
): boolean {
  return chatOutboxOwner(host).update(host, updates) !== null;
}

/**
 * `replaces` admits the item as the stored replacement for another row, which
 * retires the source in the same write. A rejected write changes nothing, so an
 * edited message can never lose both its original and its replacement.
 */
export function admitQueuedMessageForSession(
  host: ChatQueueScopedSessionHost,
  captured: ReturnType<typeof captureChatOutboxAdmission>,
  item: ChatQueueItem,
  replaces?: StoredChatQueueReplacement,
): boolean {
  return admitQueuedMessageForSessionResult(host, captured, item, replaces) === "admitted";
}

export function admitQueuedMessageForSessionResult(
  host: ChatQueueScopedSessionHost,
  captured: ReturnType<typeof captureChatOutboxAdmission>,
  item: ChatQueueItem,
  replaces?: StoredChatQueueReplacement,
): ChatQueueAdmissionResult {
  return chatOutboxOwner(host).admit(host, captured, item, replaces);
}

export function removeQueuedMessageWithoutReleasing(
  host: ChatQueueScopedSessionHost,
  id: string,
): ChatQueueItem | null {
  return chatOutboxOwner(host).remove(host, id);
}

export function excludeComposerAttachments(
  host: { chatAttachments?: ChatAttachment[] },
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  if (!attachments?.length) {
    return attachments ? [] : undefined;
  }
  const retainedIds = new Set((host.chatAttachments ?? []).map((attachment) => attachment.id));
  return attachments.filter((attachment) => !retainedIds.has(attachment.id));
}

export function removeQueuedMessage(
  host: ChatQueueScopedSessionHost,
  id: string,
  options?: { discard?: boolean },
) {
  const item = readQueuedMessageById(host, id);
  const removed = item ? chatOutboxOwner(host).remove(host, id, options) : null;
  if (removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
  return removed ? ("removed" as const) : item ? ("rejected" as const) : ("absent" as const);
}

export function removeDeliveredQueuedChatSendForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
): ChatQueueItem | null {
  const match = readDeliveredQueuedChatSendForRun(host, runId, scope);
  if (!match) {
    return null;
  }
  const removed = removeQueuedMessageWithoutReleasing(host, match.item.id);
  if (!removed) {
    return null;
  }
  releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  return removed;
}

export function readDeliveredQueuedChatSendForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
): { item: ChatQueueItem; outbox: StoredChatOutbox } | null {
  if (!runId) {
    return null;
  }
  const scopeKey = storedChatOutboxScopeKey(scope);
  const outbox = listStoredChatOutboxes(host).find(
    (candidate) => storedChatOutboxScopeKey(candidate) === scopeKey,
  );
  const item = outbox?.queue.find((candidate) => candidate.sendRunId === runId);
  return item && outbox ? { item, outbox } : null;
}

export function clearPendingQueueItemsForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
) {
  if (!runId) {
    return;
  }
  const removed = chatOutboxOwner(host).retirePendingRun(host, runId);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}
