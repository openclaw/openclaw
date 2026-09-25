import type { GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerChatGoalsEnglish } from "../../i18n/locales/en-chat-goals.ts";
import {
  chatQueueMovableSegments,
  compareChatQueueOrder,
  isMovableChatQueueItem,
  reorderChatQueueItems,
} from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { hasUiSessionDefaults } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  isExpiredIncognitoSession,
  isInitialChatHistoryUnavailable,
} from "./chat-history-state.ts";
import {
  flushStoredChatOutbox,
  resumeStoredChatOutboxes as resumeStoredChatOutboxesDrain,
  scheduleStoredChatOutboxDrain,
} from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import {
  admitQueuedMessageForSession,
  readQueuedMessageById,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies, deliverChatQueueItem } from "./chat-send-delivery.ts";
import {
  canSendVolatileQueueItem,
  reconnectSafeQueuedSendState,
  setChatError,
} from "./chat-send-queue-state.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";
import {
  isQueuedMessageBeingEdited,
  QUEUED_MESSAGE_RETRY_CONFLICT_ERROR,
  QUEUED_MESSAGE_REORDER_CONFLICT_ERROR,
  QUEUED_MESSAGE_STEER_CONFLICT_ERROR,
} from "./queued-message-edit.ts";

registerChatGoalsEnglish();

function hasUncertainChatDelivery(entry: ChatQueueItem): boolean {
  return Boolean(
    entry.sendRunId &&
    !entry.localCommandName &&
    (entry.sendState === "unconfirmed" ||
      (entry.sendState === "held" &&
        ((entry.sendAttempts ?? 0) > 0 || entry.sendRequestStartedAtMs !== undefined))),
  );
}

const resetRetryState = (
  entry: ChatQueueItem,
  sendState: ChatQueueItem["sendState"],
): ChatQueueItem => {
  // An ID-less post-clear review barrier has no transport attempt to preserve.
  const uncertain = hasUncertainChatDelivery(entry);
  return {
    ...entry,
    // Local payload failure cannot erase an uncertain transport attempt. Keep its
    // identity until the explicitly admitted retry actually reaches transport.
    sendAttempts: uncertain ? entry.sendAttempts : 0,
    // A failed delivery keeps its diagnostic while an explicit retry waits for
    // run admission; the transcript uses it to retain the same optimistic row.
    sendError: entry.sendState === "failed" ? entry.sendError : undefined,
    sendRequestStartedAtMs: uncertain ? entry.sendRequestStartedAtMs : undefined,
    sendRunId:
      entry.sendState === "failed" && entry.queueMode !== "steer" && !entry.intent
        ? generateUUID()
        : entry.sendRunId,
    sendState: uncertain ? "unconfirmed" : sendState,
  };
};

export async function steerQueuedChatMessage(host: ChatHost, id: string): Promise<void> {
  if (chatProviderReviewRow(host)?.providerReview || isInitialChatHistoryUnavailable(host)) {
    return;
  }
  if (readQueuedMessageById(host, id)?.intent) {
    setChatError(host, t("chat.goals.admissionImmutable"));
    return;
  }
  if (isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_STEER_CONFLICT_ERROR);
    return;
  }
  const item = updateQueuedMessage(host, id, (entry) => ({ ...entry, queueMode: "steer" }));
  if (!item) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  await retryQueuedChatMessage(host, id);
}

export const resumeStoredChatOutboxes = (host: ChatHost, event?: GatewayEventFrame) =>
  resumeStoredChatOutboxesDrain(host, chatOutboxDrainDependencies, event);

export const flushChatQueueForEvent = (host: ChatHost) =>
  flushStoredChatOutbox(host, chatOutboxDrainDependencies);

/**
 * Moves a queued row to the target row's position in its own movable segment. A locked row
 * ends that segment, so the move can never carry a message past work the drain
 * is still waiting on. Every changed row commits as one durable unit, so a
 * storage failure mid-permutation leaves the prior order intact instead of a
 * partially reshuffled queue.
 */
type ChatQueueMoveResult = "moved" | "rejected" | "noop";

export function moveQueuedChatMessage(
  host: ChatHost,
  id: string,
  targetId: string,
): ChatQueueMoveResult {
  const owner = chatOutboxOwner(host);
  const located = owner.locate(host, id);
  if (!located || !isMovableChatQueueItem(located.item)) {
    return "noop";
  }
  if (isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
    return "rejected";
  }
  const scope = owner.snapshot(host, located.scope);
  // Stable targets survive display filtering and intervening queue changes.
  // Inspect edits before splitting so crossing a peer's edit remains a visible conflict.
  const offeredSegment = chatQueueMovableSegments(scope).find((rows) =>
    rows.some((row) => row.id === id),
  );
  const fromIndex = offeredSegment?.findIndex((row) => row.id === id) ?? -1;
  const requestedIndex = offeredSegment?.findIndex((row) => row.id === targetId) ?? -1;
  if (fromIndex < 0 || requestedIndex < 0 || fromIndex === requestedIndex) {
    return "noop";
  }
  const crossedPeerEdit = offeredSegment!
    .slice(Math.min(fromIndex, requestedIndex), Math.max(fromIndex, requestedIndex) + 1)
    .some((row) => isQueuedMessageBeingEdited(host, row.id));
  if (crossedPeerEdit) {
    setChatError(host, QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
    return "rejected";
  }
  const segment = chatQueueMovableSegments(
    offeredSegment!,
    (row) => !isQueuedMessageBeingEdited(host, row.id),
  ).find((rows) => rows.some((row) => row.id === id));
  const segmentTargetIndex = segment?.findIndex((row) => row.id === targetId) ?? -1;
  const moves = reorderChatQueueItems(segment ?? [], id, segmentTargetIndex);
  if (moves.length === 0) {
    return "noop";
  }
  const movedById = new Map(moves.map((item) => [item.id, item]));
  const segmentIds = new Set(segment!.map((item) => item.id));
  const reordered = scope
    .map((item) => movedById.get(item.id) ?? item)
    .toSorted(compareChatQueueOrder);
  // Expanding equal positions must not carry a row across a locked neighbor.
  if (reordered.some((item, index) => !segmentIds.has(item.id) && scope[index]?.id !== item.id)) {
    return "noop";
  }
  const applied = chatOutboxOwner(host).update(
    host,
    moves.map((moved) => ({
      id: moved.id,
      update: (entry: ChatQueueItem) => ({ ...entry, orderKey: moved.orderKey }),
    })),
  );
  if (applied === null) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "rejected";
  }
  for (const key of ["lastError", "chatError"] as const) {
    if (host[key] === QUEUED_MESSAGE_REORDER_CONFLICT_ERROR) {
      host[key] = null;
    }
  }
  return "moved";
}

export async function retryQueuedChatMessage(
  host: ChatHost,
  id: string,
  canDispatch?: () => boolean,
) {
  if (
    chatProviderReviewRow(host)?.providerReview ||
    isInitialChatHistoryUnavailable(host) ||
    (canDispatch && !canDispatch())
  ) {
    return;
  }
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (isExpiredIncognitoSession(host, item?.sessionKey ?? host.sessionKey)) {
    return;
  }
  const retriesFailedDelivery = item?.sendState === "failed" && !item.localCommandName;
  const retriesUnconfirmed = item !== undefined && hasUncertainChatDelivery(item);
  if (isQueuedMessageBeingEdited(host, id)) {
    setChatError(host, QUEUED_MESSAGE_RETRY_CONFLICT_ERROR);
    return;
  }
  if (
    !item ||
    item.pendingRunId ||
    item.sendState === "executing-command" ||
    item.sendState === "submitting" ||
    item.sendState === "sending" ||
    item.sendState === "waiting-model"
  ) {
    return;
  }
  const owner = chatOutboxOwner(host);
  const located = owner.locate(host, item.id);
  if (!located) {
    return;
  }
  if (!located.durable) {
    const wasVolatile = chatOutboxOwner(host).hasVolatile(host, item.id);
    const admission = { scope: located.scope, awaitingDefaults: !hasUiSessionDefaults(host) };
    if (!admitQueuedMessageForSession(host, admission, item)) {
      if (
        wasVolatile &&
        !item.localCommandName &&
        item.sendRunId &&
        (item.sendState === "failed" ||
          item.sendState === "unconfirmed" ||
          item.sendState === "held") &&
        canSendVolatileQueueItem(host, item)
      ) {
        const retry = chatOutboxOwner(host).change(host, id, (entry) =>
          resetRetryState(entry, undefined),
        );
        if (!retry) {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
        await deliverChatQueueItem(host, retry, {
          routingSessionKey: retry.sessionKey ?? host.sessionKey,
          storageMode: "memory",
          canDispatch,
        });
        return;
      }
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
  }
  const retry = updateQueuedMessage(host, id, (entry) =>
    resetRetryState(entry, reconnectSafeQueuedSendState(host)),
  );
  if (!retry) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const retried = owner.locate(host, retry.id);
  if (!retried?.durable) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return;
  }
  const outbox = retried.scope;
  const explicitAdmission = retry.queueMode || retriesFailedDelivery || retriesUnconfirmed;
  const drain = scheduleStoredChatOutboxDrain(
    host,
    outbox,
    chatOutboxDrainDependencies,
    explicitAdmission ? retry.id : undefined,
    explicitAdmission
      ? {
          routingSessionKey: host.sessionKey,
          canDispatch,
          ...(retriesFailedDelivery ? { allowActiveRunSend: true } : {}),
        }
      : undefined,
  );
  if (host.chatSending && host.chatSendingScopeKey === storedChatOutboxScopeKey(outbox)) {
    void drain;
    return;
  }
  await drain;
  if (!host.chatRunId) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
}
