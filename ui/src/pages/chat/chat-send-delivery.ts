import { loadStreamingMarkdown } from "../../components/markdown-live-loader.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import {
  flushStoredChatOutbox,
  scheduleStoredChatOutboxDrain as scheduleOutboxDrain,
  type ChatOutboxDrainDependencies,
  type QueuedChatSendOptions,
  type QueuedChatSendResult,
} from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  deliveryStateWriter,
  finishChatDeliveryAdmission,
  resolveQueuedChatLeaf,
  settleDeliverySettings,
  waitForQueuedChatHistory,
} from "./chat-send-queue-state.ts";
import { surfaceChatDeliveryFailure } from "./chat-send-support.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

export async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  options?: QueuedChatSendOptions,
  queuedSessionKey = host.sessionKey,
  allowNativeRecovery = true,
): Promise<QueuedChatSendResult> {
  const storageMode = options?.storageMode ?? "durable";
  const connectionIsCurrent = captureChatConnectionOwner(host, false);
  let queued = readQueuedMessageById(host, id);
  const approvedReset = queued?.localCommandName === "reset" && Boolean(options?.target);
  if (!queued || queued.pendingRunId || (queued.localCommandName && !approvedReset)) {
    return "failed";
  }
  const retrySessionKey = queued.sessionKey ?? queuedSessionKey;
  const retryAgentId = queued.agentId;
  const retryOwnerIsCurrent = () => {
    if (!options?.canDispatch || options.canDispatch()) {
      return true;
    }
    deliveryStateWriter(host, storageMode, id)("failed", INTERRUPTED_SETTINGS_WAIT_ERROR);
    surfaceChatDeliveryFailure(
      host,
      retrySessionKey,
      retryAgentId,
      INTERRUPTED_SETTINGS_WAIT_ERROR,
    );
    return false;
  };
  if (!retryOwnerIsCurrent()) {
    return "failed";
  }
  let expectedLeafEntryId = resolveQueuedChatLeaf(host, queued, options);
  const history = queued.sendAttempts
    ? undefined
    : waitForQueuedChatHistory(host, queued, queuedSessionKey, options);
  if (history) {
    const ready = await history;
    if (!retryOwnerIsCurrent()) {
      return "failed";
    }
    if (!ready) {
      return "pending";
    }
    ({ item: queued, expectedLeafEntryId } = ready);
  }
  // FIFO and visible history are admitted before preparing transport and the first reply.
  const { sendPreparedChatQueueItem: sendPrepared, error: preparationError } = await Promise.all([
    import("./chat-send-delivery.runtime.ts").then(
      ({ sendPreparedChatQueueItem }) => sendPreparedChatQueueItem,
    ),
    loadStreamingMarkdown(),
  ]).then(
    ([sendPreparedChatQueueItem]) => ({ sendPreparedChatQueueItem, error: undefined }),
    (error: unknown) => ({ sendPreparedChatQueueItem: undefined, error }),
  );
  if (!connectionIsCurrent()) {
    return "pending";
  }
  const current = readQueuedMessageById(host, id);
  if (!current || !sameQueuedDeliveryVersion(current, queued)) {
    return "pending";
  }
  if (!retryOwnerIsCurrent()) {
    return "failed";
  }
  if (!sendPrepared) {
    const error = formatUiError(preparationError);
    deliveryStateWriter(host, storageMode, id)("failed", error);
    surfaceChatDeliveryFailure(host, retrySessionKey, retryAgentId, error);
    return "failed";
  }
  return sendPrepared(
    host,
    current,
    expectedLeafEntryId,
    options,
    queuedSessionKey,
    allowNativeRecovery,
    retryOwnerIsCurrent,
  );
}

export async function deliverChatQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  options: QueuedChatSendOptions = {},
): Promise<QueuedChatSendResult> {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const storageMode = options.storageMode ?? "durable";
  const routingSessionKey = options.routingSessionKey ?? sessionKey;
  const deliveryConnectionIsCurrent = captureChatConnectionOwner(host, false);
  const deliveryAgentId =
    item.agentId ?? scopedAgentIdForSession(host, routingSessionKey) ?? undefined;
  const sendOptions = { ...options, routingSessionKey, storageMode };
  let result: QueuedChatSendResult;
  if (storageMode === "memory") {
    result = await sendQueuedChatMessage(host, item.id, sendOptions, sessionKey);
  } else {
    const outbox = listStoredChatOutboxes(host).find((candidate) =>
      candidate.queue.some((entry) => entry.id === item.id),
    );
    if (!outbox) {
      // Admission succeeded; removal or another drain can retire the row while we yield.
      chatOutboxOwner(host).syncHost(host);
      return "pending";
    }
    const drain = async (admittedItem: ChatQueueItem): Promise<QueuedChatSendResult> => {
      const routeVisible = visibleSessionMatches(host, routingSessionKey, admittedItem.agentId);
      if (
        routeVisible &&
        !admittedItem.queueMode &&
        !sendOptions.allowActiveRunSend &&
        (isChatBusy(host) || hasDirectSessionRun(host))
      ) {
        const parked = finishChatDeliveryAdmission(
          host,
          admittedItem,
          storageMode,
          sessionKey,
          sendOptions,
        );
        if (typeof parked === "string") {
          if (parked === "pending") {
            // A local busy flag can outlive a missed terminal event. Reconcile
            // through the outbox owner before leaving the follow-up parked.
            void scheduleOutboxDrain(
              host,
              outbox,
              chatOutboxDrainDependencies,
              undefined,
              undefined,
              undefined,
              true,
            );
          }
          return parked;
        }
      }
      if (!host.connected || !host.client) {
        return "pending";
      }
      // FIFO may have already spent a reconnect or settings-event drain while
      // this row was waiting-model, so foreground admission owns the wakeup.
      const drained = routeVisible
        ? await scheduleOutboxDrain(host, outbox, chatOutboxDrainDependencies, item.id, {
            ...sendOptions,
            pendingSettings: undefined,
          })
        : await scheduleOutboxDrain(host, outbox, chatOutboxDrainDependencies);
      return drained ?? "pending";
    };
    const initialSettings = item.localCommandName
      ? undefined
      : (sendOptions.pendingSettings ??
        getPendingChatPickerPatch(host, routingSessionKey, item.agentId));
    result = initialSettings
      ? await settleDeliverySettings(
          host,
          item,
          storageMode,
          sessionKey,
          { ...sendOptions, pendingSettings: initialSettings },
          drain,
        )
      : await drain(item);
  }
  if (result === "sent" && visibleSessionMatches(host, sessionKey, deliveryAgentId)) {
    resetChatInputHistoryNavigation(host);
  }
  if (
    deliveryConnectionIsCurrent() &&
    visibleSessionMatches(host, routingSessionKey, deliveryAgentId)
  ) {
    scheduleChatScroll(host, true, true);
  }
  if (
    result === "sent" &&
    visibleSessionMatches(host, sessionKey, deliveryAgentId) &&
    !host.chatRunId
  ) {
    void flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
  return result;
}

export const chatOutboxDrainDependencies: ChatOutboxDrainDependencies = {
  sendQueuedChatMessage,
};
