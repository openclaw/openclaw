import { t } from "../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import {
  getChatHistoryLoadState,
  isExpiredIncognitoSession,
  isInitialChatHistoryUnavailable,
  setChatError,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type {
  QueuedChatSendOptions,
  QueuedChatSendResult,
  QueuedChatStorageMode,
} from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { chatProviderReviewRow, holdProviderReviewQueuedInputs } from "./chat-provider-review.ts";
import { readQueuedMessageById, updateQueuedMessage } from "./chat-queue.ts";
import { restoreRejectedChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { reconnectSafeQueuedSendState } from "./chat-send-eligibility.ts";
import { resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import {
  chatSendHoldReason,
  surfaceChatDeliveryFailure,
  OFFLINE_QUEUE_STORAGE_ERROR,
} from "./chat-send-support.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";

registerChatMessageMetadataEnglish();

export function resolveQueuedChatLeaf(
  host: ChatHost,
  item: ChatQueueItem,
  options?: QueuedChatSendOptions,
): string | null | undefined {
  if (options?.expectedLeafEntryId !== undefined) {
    return options.expectedLeafEntryId;
  }
  return options?.routingSessionKey &&
    visibleSessionMatches(host, item.sessionKey ?? host.sessionKey, item.agentId)
    ? resolveDisplayedLeafEntryId(host)
    : undefined;
}

export function waitForQueuedChatHistory(
  host: ChatHost,
  item: ChatQueueItem,
  queuedSessionKey: string,
  options?: QueuedChatSendOptions,
):
  | Promise<{ item: ChatQueueItem; expectedLeafEntryId: string | null | undefined } | null>
  | undefined {
  const sessionKey = item.sessionKey ?? queuedSessionKey;
  if (
    !host.connected ||
    !host.client ||
    !visibleSessionMatches(host, sessionKey, item.agentId) ||
    (!host.chatLoading && !isInitialChatHistoryUnavailable(host))
  ) {
    return undefined;
  }
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const sessions = host.sessions;
  const history = getChatHistoryLoadState(host);
  // Background outbox wakeups cannot take over the transcript's visible Retry action.
  if (history.phase === "failed") {
    return Promise.resolve(null);
  }
  // The outbox already owns the draft. Join startup before reusing cached
  // session/branch identity, without issuing a competing history request.
  const loading =
    history.phase === "in-flight"
      ? history.promise
      : loadChatHistory(host, {
          startup: isInitialChatHistoryUnavailable(host),
          deferBranches: true,
        });
  return loading.then((loaded) => {
    const current = readQueuedMessageById(host, item.id);
    if (
      !loaded ||
      !connectionIsCurrent() ||
      host.sessions !== sessions ||
      !visibleSessionMatches(host, sessionKey, item.agentId) ||
      !current ||
      !sameQueuedDeliveryVersion(current, item) ||
      isQueuedMessageBeingEdited(host, item.id)
    ) {
      return null;
    }
    return { item: current, expectedLeafEntryId: resolveQueuedChatLeaf(host, current, options) };
  });
}

export function updateQueuedSendItem(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return storageMode === "memory"
    ? chatOutboxOwner(host).change(host, id, update, true)
    : updateQueuedMessage(host, id, update);
}

export function deliveryStateWriter(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  id: string,
) {
  return (sendState: ChatQueueItem["sendState"], sendError?: string) =>
    updateQueuedSendItem(host, storageMode, id, (item) =>
      item.sendState === "held" ? item : { ...item, sendError, sendState },
    );
}

export function finishChatDeliveryAdmission(
  host: ChatHost,
  item: ChatQueueItem,
  storageMode: QueuedChatStorageMode,
  queueSessionKey: string,
  options?: QueuedChatSendOptions,
): ChatQueueItem | QueuedChatSendResult {
  const route = options?.routingSessionKey ?? queueSessionKey;
  const setState = deliveryStateWriter(host, storageMode, item.id);
  const routeVisible = (agentId = item.agentId) => visibleSessionMatches(host, route, agentId);
  const current = readQueuedMessageById(host, item.id);
  if (!current) {
    return "failed";
  }
  if (current.sendState === "held") {
    return "pending";
  }
  if (isExpiredIncognitoSession(host, route)) {
    return "pending";
  }
  if (current.workContextUnavailable) {
    const error = t("chat.messages.attachedContext.restoreFailed");
    setState("failed", error);
    surfaceChatDeliveryFailure(host, route, current.agentId, error);
    return "failed";
  }
  if (chatProviderReviewRow(host, route, current.agentId)?.providerReview) {
    holdProviderReviewQueuedInputs(host, route, current.agentId);
    return "pending";
  }
  const sendsDuringActiveRun = Boolean(current.queueMode || options?.allowActiveRunSend);
  if (
    chatSendHoldReason(host, route, false, current.agentId) ||
    chatOutboxOwner(host).admissions.has(
      resolveUiConversationIdentity(host, queueSessionKey, current.agentId),
    ) ||
    (options?.routingSessionKey && !routeVisible(current.agentId)) ||
    (!sendsDuringActiveRun &&
      !current.sendAttempts &&
      routeVisible(current.agentId) &&
      (isChatBusy(host) || hasDirectSessionRun(host)))
  ) {
    const parked = setState(reconnectSafeQueuedSendState(host));
    if (!parked) {
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return "failed";
    }
    return "pending";
  }
  return current;
}

export async function settleDeliverySettings(
  host: ChatHost,
  item: ChatQueueItem,
  storageMode: QueuedChatStorageMode,
  queueSessionKey: string,
  options: QueuedChatSendOptions | undefined,
  deliver: (item: ChatQueueItem) => QueuedChatSendResult | Promise<QueuedChatSendResult>,
): Promise<QueuedChatSendResult> {
  const route = options?.routingSessionKey ?? queueSessionKey;
  const setState = deliveryStateWriter(host, storageMode, item.id);
  const routeVisible = (agentId = item.agentId) => visibleSessionMatches(host, route, agentId);
  const consumed = new Set<Promise<boolean>>();
  let pendingSettings =
    options?.pendingSettings ?? getPendingChatPickerPatch(host, route, item.agentId);
  let current = pendingSettings ? readQueuedMessageById(host, item.id) : item;

  while (pendingSettings && !consumed.has(pendingSettings)) {
    if (current?.sendState === "held") {
      return "pending";
    }
    if (current?.sendState !== "waiting-model") {
      current = setState("waiting-model");
      if (!current) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
    }
    const ready = await pendingSettings;
    consumed.add(pendingSettings);
    current = readQueuedMessageById(host, item.id);
    if (!current) {
      return "failed";
    }
    if (current.sendState === "held") {
      return "pending";
    }
    if (!ready) {
      const restored =
        routeVisible(current.agentId) && restoreRejectedChatDelivery(host, current, options);
      if (!restored && !setState("failed", INTERRUPTED_SETTINGS_WAIT_ERROR)) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
      return "failed";
    }
    pendingSettings = getPendingChatPickerPatch(host, route, current.agentId);
  }
  if (consumed.size) {
    // Publish only after the complete picker tail, then continue synchronously:
    // returning to an awaiting caller would admit another picker in that gap.
    current = setState(reconnectSafeQueuedSendState(host));
  }
  if (!current) {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return "failed";
  }
  return deliver(current);
}
