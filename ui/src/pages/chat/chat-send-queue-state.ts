import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
import { GatewayPayloadLimitError, GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachment, ChatQueueItem, HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import {
  captureChatOutboxAdmission,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
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
import { CHAT_OUTBOX_RETRY_DEFAULT_MS, retryableGatewayDelayMs } from "./chat-outbox-retry.ts";
import { chatProviderReviewRow, holdProviderReviewQueuedInputs } from "./chat-provider-review.ts";
import { readQueuedMessageById, updateQueuedMessage } from "./chat-queue.ts";
import { restoreRejectedChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { isActiveLeafChangedError, resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import {
  chatSendHoldReason,
  surfaceChatDeliveryFailure,
  OFFLINE_QUEUE_STORAGE_ERROR,
  UNCONFIRMED_CHAT_SEND_ERROR,
} from "./chat-send-support.ts";
import { recordChatSendTiming, schedulePendingSendPaintTiming } from "./chat-send-timing.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { attachmentBatchRejection } from "./components/chat-attachment-admission.ts";
import { formatConnectError } from "./connect-error.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
  retireOutboxPayload,
} from "./outbox-payloads.ts";
import { controlUiNowMs } from "./performance.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

registerChatMessageMetadataEnglish();

export function createPendingSendMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  submittedAtMs = controlUiNowMs(),
  sendState?: ChatQueueItem["sendState"],
  replyToId?: string,
  resumedOrderKey?: number,
  queueMode?: ChatQueueItem["queueMode"],
  intent?: ChatQueueItem["intent"],
  expectedLeafEntryId?: string | null,
  mentions?: readonly HumanMention[],
  workContext?: ChatWorkContext,
): { item: ChatQueueItem; admission: ReturnType<typeof captureChatOutboxAdmission> } | null {
  const submitted = trimHumanMentions(text, mentions);
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!submitted.text && !hasAttachments) {
    return null;
  }
  const admission = captureChatOutboxAdmission(host, host.sessionKey);
  const sender = resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser);
  // A send that resumes an edited row inherits its place; the row itself is
  // retired by the write that admits this replacement, not here.
  const pending: ChatQueueItem = {
    storageScope: outboxStorageScope(host),
    id: generateUUID(),
    text: intent ? text : submitted.text,
    ...(submitted.mentions ? { mentions: submitted.mentions } : {}),
    ...(workContext ? { workContext } : {}),
    createdAt: Date.now(),
    ...(resumedOrderKey !== undefined ? { orderKey: resumedOrderKey } : {}),
    attachments: hasAttachments ? attachments : undefined,
    refreshSessions,
    sendAttempts: 0,
    sendRunId: generateUUID(),
    sendState,
    ...(queueMode ? { queueMode } : {}),
    ...(intent
      ? { intent, ...(host.currentSessionId ? { sessionId: host.currentSessionId } : {}) }
      : {}),
    ...(intent && expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
    sendSubmittedAtMs: submittedAtMs,
    ...admission.scope,
    ...(sender ? { sender } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
  return { item: pending, admission };
}

export function publishPendingSendMessage(host: ChatHost, pending: ChatQueueItem): ChatQueueItem {
  const submittedAtMs = pending.sendSubmittedAtMs ?? controlUiNowMs();
  const positioned = chatOutboxOwner(host).keep(
    host,
    { sessionKey: pending.sessionKey!, agentId: pending.agentId },
    pending,
  );
  recordChatSendTiming(host, positioned, "pending-visible", submittedAtMs);
  if (positioned.sendState === "waiting-model" || positioned.sendState === "waiting-reconnect") {
    recordChatSendTiming(host, positioned, positioned.sendState, submittedAtMs);
  }
  schedulePendingSendPaintTiming(host, positioned, submittedAtMs);
  scheduleChatScroll(host, true, true, { source: "manual" });
  return positioned;
}

export function reconnectSafeQueuedSendState(
  host: Pick<ChatHost, "client" | "connected">,
): "waiting-idle" | "waiting-reconnect" {
  return host.connected && host.client ? "waiting-idle" : "waiting-reconnect";
}

export function captureChatConnectionOwner(
  host: Pick<ChatHost, "client" | "connected" | "connectionEpoch">,
  requireConnected = true,
): () => boolean {
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  return () =>
    (!requireConnected || host.connected) &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch;
}

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
  if (current.sendState === "held" || (current.sendState === "unconfirmed" && !current.sendRunId)) {
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
    (options?.routingSessionKey && !routeVisible(current.agentId)) ||
    (!sendsDuringActiveRun &&
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

export function canSendVolatileQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  routingSessionKey = item.sessionKey ?? host.sessionKey,
): boolean {
  return (
    host.connected &&
    Boolean(host.client) &&
    !host.chatLoading &&
    !isInitialChatHistoryUnavailable(host) &&
    !isExpiredIncognitoSession(host, routingSessionKey) &&
    !isChatBusy(host) &&
    !getPendingChatPickerPatch(host, routingSessionKey, item.agentId) &&
    visibleSessionMatches(host, routingSessionKey, item.agentId) &&
    host.chatQueue[0]?.id === item.id
  );
}

export function finishScopedChatSending(host: ChatHost, scope: StoredChatOutboxScope): void {
  if (host.chatSendingScopeKey !== storedChatOutboxScopeKey(scope)) {
    return;
  }
  host.chatSendingScopeKey = null;
  host.chatSending = false;
}

export function rejectOversizedQueuedChatDelivery(
  host: ChatHost,
  prepared: ChatQueueItem,
  attachments: readonly ChatAttachment[],
  sessionKey: string,
  options: QueuedChatSendOptions | undefined,
): boolean {
  const error = attachmentBatchRejection(attachments, host.hello?.policy);
  if (error === undefined) {
    return false;
  }
  const storageMode = options?.storageMode ?? "durable";
  const setState = deliveryStateWriter(host, storageMode, prepared.id);
  if (!restoreRejectedChatDelivery(host, prepared, options)) {
    setState("failed", error);
  }
  surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, error);
  return true;
}

/** Settle transport failures without turning an unconfirmed send into a fresh attempt. */
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
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error: message });
  };
  // A review can hold an already-dispatched request. Its later failure cannot
  // restore passive retry authority, even after the provider pause has cleared.
  if (readQueuedMessageById(host, id)?.sendState === "held") {
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
    return "pending";
  }
  if (err instanceof GatewayPayloadLimitError) {
    if (!restoreRejectedChatDelivery(host, prepared, options)) {
      setState("failed", error);
    }
    reportFailure();
    return "failed";
  }
  if (err instanceof GatewayProtocolRequestTimeoutError && err.requestSent) {
    // The server may have accepted the input. Preserve its ID and retry payload;
    // the existing outbox drain can read receipts, never passively resend it.
    finishScopedChatSending(host, scope);
    // A live receipt or another pane can retire this row before the ACK deadline.
    // Missing custody is not a failed storage write, and must not resurrect it.
    if (!readQueuedMessageById(host, id)) {
      return "pending";
    }
    const retained = setState("unconfirmed", UNCONFIRMED_CHAT_SEND_ERROR);
    surfaceChatDeliveryFailure(
      host,
      sessionKey,
      prepared.agentId,
      retained ? UNCONFIRMED_CHAT_SEND_ERROR : OFFLINE_QUEUE_STORAGE_ERROR,
      { inline: Boolean(retained && !prepared.localCommandName) },
    );
    if (retained && storageMode === "durable") {
      scheduleRetry(CHAT_OUTBOX_RETRY_DEFAULT_MS);
    }
    recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
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
    const rollbackAttempt = safelyRejected
      ? {
          sendAttempts: queued.sendAttempts,
          sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
        }
      : {};
    if (storageMode === "memory") {
      const restore = safelyRejected && restoreRejectedChatDelivery(host, prepared, options);
      if (!restore) {
        updateQueuedSendItem(host, storageMode, id, (item) => ({
          ...item,
          ...rollbackAttempt,
          sendError: safelyRejected ? error : UNCONFIRMED_CHAT_SEND_ERROR,
          sendState: safelyRejected ? "failed" : "unconfirmed",
        }));
      }
      reportFailure(restore ? error : OFFLINE_QUEUE_STORAGE_ERROR);
      return restore ? "failed" : "pending";
    }
    const waiting = updateQueuedMessage(host, id, (item) => ({
      ...item,
      ...rollbackAttempt,
      sendError: error,
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
    if (visibleSessionMatches(host, sessionKey, prepared.agentId)) {
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
    recordChatSendTiming(host, prepared, "waiting-reconnect", prepared.sendSubmittedAtMs, {
      error,
    });
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
    if (
      current?.sendState === "held" ||
      (current?.sendState === "unconfirmed" && !current.sendRunId)
    ) {
      return "pending";
    }
    if (current?.sendState !== "waiting-model") {
      current = setState("waiting-model");
      if (!current) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
    }
    host.requestUpdate?.();

    const ready = await pendingSettings;
    consumed.add(pendingSettings);
    current = readQueuedMessageById(host, item.id);
    if (!current) {
      return "failed";
    }
    if (
      current.sendState === "held" ||
      (current.sendState === "unconfirmed" && !current.sendRunId)
    ) {
      return "pending";
    }
    if (!ready) {
      const restored =
        routeVisible(current.agentId) && restoreRejectedChatDelivery(host, current, options);
      if (!restored && !setState("failed", INTERRUPTED_SETTINGS_WAIT_ERROR)) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      }
      host.requestUpdate?.();
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
  if (consumed.size) {
    host.requestUpdate?.();
  }
  return deliver(current);
}

export async function waitForPendingChatSettings(
  host: ChatHost,
  sessionKey: string,
  initialPending: Promise<boolean>,
  agentId?: string,
): Promise<boolean> {
  let pending = initialPending;
  while (await pending) {
    const nextPending = getPendingChatPickerPatch(host, sessionKey, agentId);
    if (!nextPending || nextPending === pending) {
      return true;
    }
    pending = nextPending;
  }
  return false;
}

export async function prepareQueuedChatPayload(
  host: ChatHost,
  queued: ChatQueueItem,
  queuedSessionKey: string,
): Promise<ChatQueueItem | QueuedChatSendResult> {
  const id = queued.id;
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const original = queued;
  const sessionKey = original.sessionKey ?? queuedSessionKey;
  const ownerIsCurrent = captureOutboxPayloadOwner(
    host,
    resolveUiConversationIdentity(host, sessionKey, original.agentId),
  );
  const payload = await prepareOutboxPayload(host, { ...original, sessionKey });
  const current = readQueuedMessageById(host, id);
  if (
    !connectionIsCurrent() ||
    !ownerIsCurrent() ||
    !current ||
    !sameQueuedDeliveryVersion(current, original) ||
    isQueuedMessageBeingEdited(host, id)
  ) {
    if (payload.status === "ready" && !original.attachmentPayload) {
      retireOutboxPayload(payload.update);
    }
    return "pending";
  }
  if (payload.status === "failed") {
    const failed = failOutboxPayload(current, payload.reason);
    updateQueuedMessage(host, id, () => failed);
    surfaceChatDeliveryFailure(host, sessionKey, original.agentId, failed.sendError);
    return "failed";
  }
  const hydrated = { ...original, ...payload.update };
  if (
    hydrated.attachmentPayload?.key !== original.attachmentPayload?.key &&
    hydrated.sendState === "unconfirmed"
  ) {
    updateQueuedMessage(host, id, () => hydrated);
    return "pending";
  }
  if (
    (!original.attachmentPayload || original.attachmentStorageError) &&
    !updateQueuedMessage(host, id, () => hydrated)
  ) {
    if (!original.attachmentPayload) {
      retireOutboxPayload(payload.update);
    }
    return "pending";
  }
  return hydrated;
}
