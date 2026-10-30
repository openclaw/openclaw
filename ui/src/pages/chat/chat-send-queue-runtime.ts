import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import {
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
} from "../../../../packages/gateway-protocol/src/restart-unavailable.ts";
import { GatewayPayloadLimitError } from "../../api/gateway-browser-socket.ts";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { QueuedChatSendOptions, QueuedChatSendResult } from "./chat-outbox-drain.ts";
import { CHAT_OUTBOX_RETRY_DEFAULT_MS, retryableGatewayDelayMs } from "./chat-outbox-retry.ts";
import { readQueuedMessageById, updateQueuedMessage } from "./chat-queue.ts";
import { isActiveLeafChangedError } from "./chat-send-ack.ts";
import { restoreRejectedChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { deliveryStateWriter, updateQueuedSendItem } from "./chat-send-queue-state.ts";
import { surfaceChatDeliveryFailure, OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
  retireOutboxPayload,
} from "./outbox-payloads.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";

export function finishScopedChatSending(host: ChatHost, scope: StoredChatOutboxScope): void {
  if (host.chatSendingScopeKey !== storedChatOutboxScopeKey(scope)) {
    return;
  }
  host.chatSendingScopeKey = null;
  host.chatSending = false;
}

/** Keep ambiguous transport outcomes pending under their original admission key. */
export function settleQueuedChatSendFailure(
  host: ChatHost,
  queued: ChatQueueItem,
  prepared: ChatQueueItem,
  err: unknown,
  options: QueuedChatSendOptions | undefined,
  scope: StoredChatOutboxScope,
  scheduleRetry: (delayMs: number) => void,
): QueuedChatSendResult {
  const id = prepared.id;
  const { sessionKey } = scope;
  const storageMode = options?.storageMode ?? "durable";
  const setState = deliveryStateWriter(host, storageMode, id);
  const activeLeafChanged = isActiveLeafChangedError(err);
  const error = activeLeafChanged
    ? t("chat.sendErrors.activeLeafChanged")
    : formatConnectError(err);
  const reportFailure = (message = error, display?: { inline?: boolean }) => {
    surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, message, display);
  };
  // A review can hold an already-dispatched request. Its later failure cannot
  // restore passive retry authority, even after the provider pause has cleared.
  if (readQueuedMessageById(host, id)?.sendState === "held") {
    return "pending";
  }
  if (err instanceof GatewayPayloadLimitError) {
    if (!restoreRejectedChatDelivery(host, prepared, options)) {
      setState("failed", error);
    }
    reportFailure();
    return "failed";
  }
  if (err instanceof GatewayProtocolRequestTimeoutError) {
    // Keep the same key after refused or uncertain sends; admission deduplicates input.
    finishScopedChatSending(host, scope);
    // A live receipt or another pane can retire this row before the ACK deadline.
    // Missing custody is not a failed storage write, and must not resurrect it.
    if (!readQueuedMessageById(host, id)) {
      return "pending";
    }
    const retained = setState("waiting-reconnect");
    if (!retained) {
      reportFailure(OFFLINE_QUEUE_STORAGE_ERROR);
    }
    if (retained) {
      scheduleRetry(CHAT_OUTBOX_RETRY_DEFAULT_MS);
    }
    return "pending";
  }
  const recoverable =
    !activeLeafChanged &&
    (err instanceof GatewayRequestError
      ? err.retryable
      : /gateway (?:not connected|closed)|websocket|disconnected/i.test(error));
  if (recoverable) {
    const failedBeforeTransport =
      err instanceof Error &&
      !(err instanceof GatewayRequestError) &&
      err.message === "gateway not connected";
    const retryDelayMs = retryableGatewayDelayMs(err);
    const safelyRejected = failedBeforeTransport || retryDelayMs !== null;
    // A live receipt or another pane can retire this row while the request was
    // in flight. Missing custody is not a failed delivery: never resurrect the
    // row into the composer or report a storage failure for it.
    if (!readQueuedMessageById(host, id)) {
      finishScopedChatSending(host, scope);
      return "pending";
    }
    const rollbackAttempt = safelyRejected
      ? {
          sendAttempts: queued.sendAttempts,
          sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
        }
      : {};
    if (storageMode === "memory") {
      const restore = failedBeforeTransport && restoreRejectedChatDelivery(host, prepared, options);
      if (!restore) {
        const waiting = updateQueuedSendItem(host, storageMode, id, (item) => ({
          ...item,
          ...rollbackAttempt,
          sendError: undefined,
          sendState: "waiting-reconnect",
        }));
        if (waiting && retryDelayMs !== null) {
          scheduleRetry(retryDelayMs);
        }
      }
      if (restore) {
        reportFailure(error);
      }
      return restore ? "failed" : "pending";
    }
    const awaitingGateway =
      isGatewayRestartUnavailableError(err) || isGatewaySuspendUnavailableError(err);
    const waiting = updateQueuedMessage(host, id, (item) => ({
      ...item,
      ...rollbackAttempt,
      sendError: awaitingGateway ? undefined : error,
      sendState: "waiting-reconnect",
    }));
    if (!waiting) {
      const restore = failedBeforeTransport && restoreRejectedChatDelivery(host, prepared, options);
      if (!restore) {
        updateQueuedMessage(host, id, (item) => ({
          ...item,
          sendError: OFFLINE_QUEUE_STORAGE_ERROR,
          sendState: "failed",
        }));
      }
      reportFailure(OFFLINE_QUEUE_STORAGE_ERROR);
      return restore ? "failed" : "pending";
    }
    if (!awaitingGateway && visibleSessionMatches(host, sessionKey, prepared.agentId)) {
      setChatError(
        host,
        retryDelayMs === null
          ? "Message will send when the Gateway reconnects."
          : "The Gateway asked us to retry this message shortly.",
      );
    }
    if (retryDelayMs !== null) {
      scheduleRetry(retryDelayMs);
    }
    return "pending";
  }
  // Release the completed send before exposing its Retry action.
  finishScopedChatSending(host, scope);
  const restoreCommand =
    options?.restoreOnTerminalFailure === true &&
    restoreRejectedChatDelivery(host, prepared, options);
  if (!restoreCommand) {
    setState("failed", error);
  }
  if (visibleSessionMatches(host, sessionKey, prepared.agentId) && activeLeafChanged) {
    void Promise.all([loadChatHistory(host), loadChatBranches(host)]);
  }
  reportFailure(error, { inline: storageMode === "durable" && !restoreCommand });
  return "failed";
}

export async function prepareQueuedChatPayload(
  host: ChatHost,
  queued: ChatQueueItem,
  queuedSessionKey: string,
): Promise<ChatQueueItem | QueuedChatSendResult> {
  const id = queued.id;
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const sessionKey = queued.sessionKey ?? queuedSessionKey;
  const ownerIsCurrent = captureOutboxPayloadOwner(
    host,
    resolveUiConversationIdentity(host, sessionKey, queued.agentId),
  );
  const payload = await prepareOutboxPayload(host, { ...queued, sessionKey });
  const current = readQueuedMessageById(host, id);
  if (
    !connectionIsCurrent() ||
    !ownerIsCurrent() ||
    !current ||
    !sameQueuedDeliveryVersion(current, queued) ||
    isQueuedMessageBeingEdited(host, id)
  ) {
    if (payload.status === "ready" && !queued.attachmentPayload) {
      retireOutboxPayload(payload.update);
    }
    return "pending";
  }
  if (payload.status === "failed") {
    const failed = failOutboxPayload(current, payload.reason);
    updateQueuedMessage(host, id, () => failed);
    surfaceChatDeliveryFailure(host, sessionKey, queued.agentId, failed.sendError);
    return "failed";
  }
  const hydrated = { ...queued, ...payload.update };
  if (
    (!queued.attachmentPayload || queued.attachmentStorageError) &&
    !updateQueuedMessage(host, id, () => hydrated)
  ) {
    if (!queued.attachmentPayload) {
      retireOutboxPayload(payload.update);
    }
    return "pending";
  }
  return hydrated;
}
