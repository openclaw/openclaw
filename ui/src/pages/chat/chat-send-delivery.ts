import { readAgentRuntimeRestrictionErrorDetails } from "../../../../packages/gateway-protocol/src/index.js";
import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { discardChatAttachmentDataUrls } from "./attachment-payload-store.ts";
import { readChatResetTargetAccess } from "./chat-commands.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  flushStoredChatOutbox,
  scheduleStoredChatOutboxDrain as scheduleOutboxDrain,
  scheduleStoredChatOutboxRetry,
  type ChatOutboxDrainDependencies,
  type QueuedChatSendOptions,
  type QueuedChatSendResult,
  type QueuedChatStorageMode,
} from "./chat-outbox-drain.ts";
import {
  admitQueuedMessageForSession,
  excludeComposerAttachments,
  readQueuedMessageById,
  removeQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import { cancelChatDelivery, restoreRejectedChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  captureChatConnectionOwner,
  createPendingSendMessage,
  deliveryStateWriter,
  finishChatDeliveryAdmission,
  finishScopedChatSending,
  reconnectSafeQueuedSendState,
  prepareQueuedChatPayload,
  publishPendingSendMessage,
  resolveQueuedChatLeaf,
  setChatError,
  settleQueuedChatSendFailure,
  updateQueuedSendItem,
  waitForQueuedChatHistory,
} from "./chat-send-queue-state.ts";
import { requestChatSend } from "./chat-send-request.ts";
import {
  formatTerminalChatSendAckError,
  OFFLINE_QUEUE_STORAGE_ERROR,
  requiresChatInputConsumption,
  surfaceChatDeliveryFailure,
} from "./chat-send-support.ts";
import {
  chatSendAckServerTimingEventFields,
  recordChatSendTiming,
  registerChatSendTiming,
  updateChatSendAckTiming,
} from "./chat-send-timing.ts";
import {
  captureChatNativeRuntimeRecovery,
  getPendingChatPickerPatch,
  refreshChatSessionListForTarget,
} from "./chat-session.ts";
import { formatConnectError } from "./connect-error.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";
import { controlUiNowMs, roundedControlUiDurationMs } from "./performance.ts";
import {
  adoptStartedChatRun,
  hasDirectSessionRun,
  isChatBusy,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

async function settleDeliverySettings(
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

async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  options?: QueuedChatSendOptions,
  queuedSessionKey = host.sessionKey,
  allowNativeRecovery = true,
): Promise<QueuedChatSendResult> {
  const storageMode = options?.storageMode ?? "durable";
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
  const history = waitForQueuedChatHistory(host, queued, queuedSessionKey, options);
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
  if (
    storageMode === "durable" &&
    (queued.attachments?.length || queued.attachmentPayload || queued.attachmentStorageError)
  ) {
    const prepared = await prepareQueuedChatPayload(host, queued, queuedSessionKey);
    if (!retryOwnerIsCurrent()) {
      return "failed";
    }
    if (typeof prepared === "string") {
      return prepared;
    }
    queued = prepared;
  }
  return settleDeliverySettings(
    host,
    queued,
    storageMode,
    queued.sessionKey ?? queuedSessionKey,
    options,
    (prepared) =>
      retryOwnerIsCurrent()
        ? sendPreparedChatMessage(
            host,
            queued,
            prepared,
            options,
            queuedSessionKey,
            expectedLeafEntryId,
            approvedReset,
            allowNativeRecovery,
          )
        : "failed",
  );
}

async function sendPreparedChatMessage(
  host: ChatHost,
  queued: ChatQueueItem,
  settledItem: ChatQueueItem,
  options: QueuedChatSendOptions | undefined,
  queuedSessionKey: string,
  expectedLeafEntryId: string | null | undefined,
  approvedReset: boolean,
  allowNativeRecovery: boolean,
): Promise<QueuedChatSendResult> {
  const id = queued.id;
  const storageMode = options?.storageMode ?? "durable";
  const queueSessionKey = queued.sessionKey ?? queuedSessionKey;
  const route = options?.routingSessionKey ?? queueSessionKey;
  let prepared = finishChatDeliveryAdmission(
    host,
    settledItem,
    storageMode,
    queueSessionKey,
    options,
  );
  if (typeof prepared !== "string" && queued.attachmentPayload) {
    prepared = { ...prepared, attachments: queued.attachments };
  }
  if (typeof prepared === "string") {
    return prepared;
  }
  if (!prepared.sendRunId || !prepared.sendState) {
    const sessionKey = prepared.sessionKey ?? queuedSessionKey;
    prepared =
      updateQueuedSendItem(host, storageMode, prepared.id, (item) => ({
        ...item,
        sendAttempts: item.sendAttempts ?? 0,
        sendRunId: item.sendRunId ?? generateUUID(),
        sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
        sessionKey,
        agentId: item.agentId ?? scopedAgentIdForSession(host, sessionKey),
      })) ?? "pending";
  }
  if (typeof prepared === "string") {
    setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
    return prepared;
  }
  if (approvedReset) {
    prepared = {
      ...prepared,
      refreshSessions: true,
      text: prepared.localCommandArgs ? `/reset ${prepared.localCommandArgs}` : "/reset",
    };
  }
  const submitted = trimHumanMentions(prepared.text, prepared.mentions);
  const message = prepared.intent ? prepared.text : submitted.text;
  const attachments = (queued.attachmentPayload ? queued.attachments : prepared.attachments) ?? [];
  if (!message && attachments.length === 0) {
    removeQueuedMessageWithoutReleasing(host, id);
    return "sent";
  }
  const sessionKey = prepared.sessionKey ?? host.sessionKey;
  const setState = deliveryStateWriter(host, storageMode, id);
  if (options?.target) {
    const access = readChatResetTargetAccess(host, options.target);
    if (!access.allowed) {
      setState("failed", access.reason);
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, access.reason);
      return "failed";
    }
  }
  if (!host.connected || !host.client) {
    const waiting = setState("waiting-reconnect");
    if (!waiting && restoreRejectedChatDelivery(host, prepared, options)) {
      return "failed";
    }
    if (!waiting) {
      setState("failed", OFFLINE_QUEUE_STORAGE_ERROR);
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
    }
    return "pending";
  }

  const requestConnectionIsCurrent = captureChatConnectionOwner(host);
  const runId = prepared.sendRunId ?? generateUUID();
  const startedAt = Date.now();
  const requestStartedAtMs = controlUiNowMs();
  const sendingItem = updateQueuedSendItem(host, storageMode, id, (item) => ({
    ...item,
    sendAttempts: (item.sendAttempts ?? 0) + 1,
    sendError: undefined,
    sendRunId: runId,
    sendState: "sending",
    sendRequestStartedAtMs: requestStartedAtMs,
    sessionKey,
    agentId: prepared.agentId,
  }));
  if (!sendingItem) {
    surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
    return "pending";
  }
  registerChatSendTiming(host, sendingItem, runId, requestStartedAtMs);
  recordChatSendTiming(host, sendingItem, "request-start", sendingItem.sendSubmittedAtMs);
  const scope = {
    sessionKey,
    ...(prepared.agentId ? { agentId: prepared.agentId } : {}),
  };
  const isVisible = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
  const recoverNativeRuntime =
    allowNativeRecovery && isVisible() ? captureChatNativeRuntimeRecovery(host, route) : undefined;
  if (isVisible()) {
    host.chatSendingScopeKey = storedChatOutboxScopeKey(scope);
    host.chatSending = true;
    // Keep the current run intact until an ACK or live event owns its replacement.
    if (!host.chatRunId) {
      resetToolStream(host);
      host.providerPolicyNotice = null;
    }
    setChatError(host, null);
    reconcileChatRunLifecycle(host, {
      clearRunStatus: true,
      // A send has not replaced the active run; its progress and approvals still belong to it.
      clearIndicators: !host.chatRunId,
    });
  }

  try {
    if (options?.canDispatch && !options.canDispatch()) {
      setState("failed", INTERRUPTED_SETTINGS_WAIT_ERROR);
      surfaceChatDeliveryFailure(
        host,
        sessionKey,
        prepared.agentId,
        INTERRUPTED_SETTINGS_WAIT_ERROR,
      );
      return "failed";
    }
    const deliveryLeafEntryId = prepared.intent
      ? prepared.expectedLeafEntryId
      : expectedLeafEntryId;
    const ack = await requestChatSend(host, {
      message,
      workContext: prepared.workContext,
      mentions: submitted.mentions,
      attachments: attachments.length ? attachments : undefined,
      runId,
      sessionKey,
      agentId: prepared.agentId,
      ...(prepared.sessionId ? { sessionId: prepared.sessionId } : {}),
      ...(prepared.intent ? { intent: prepared.intent, sessionId: prepared.sessionId } : {}),
      ...(prepared.queueMode ? { queueMode: prepared.queueMode } : {}),
      ...(prepared.queueMode !== "steer" && deliveryLeafEntryId !== undefined
        ? { expectedLeafEntryId: deliveryLeafEntryId }
        : {}),
      ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
    });
    if (!requestConnectionIsCurrent()) {
      return "pending";
    }
    updateChatSendAckTiming(host, runId, ack, sendingItem, requestStartedAtMs);
    recordChatSendTiming(host, sendingItem, "ack", sendingItem.sendSubmittedAtMs, {
      ackStatus: ack.status,
      requestDurationMs: roundedControlUiDurationMs(controlUiNowMs() - requestStartedAtMs),
      ...chatSendAckServerTimingEventFields(ack),
    });
    if (isTerminalFailureChatSendAck(ack)) {
      if (ack.stopReason === "restart" && storageMode === "durable") {
        setState("waiting-reconnect");
        return "pending";
      }
      const error = formatTerminalChatSendAckError(ack, "chat");
      // Release in-flight ownership before publishing Retry; an immediate click
      // must not see this completed send as the run that blocks its replacement.
      finishScopedChatSending(host, scope);
      const restoreCommand =
        options?.restoreOnTerminalFailure === true &&
        restoreRejectedChatDelivery(host, prepared, options);
      if (!restoreCommand) {
        setState("failed", error);
      }
      if (isVisible()) {
        const projectionScope = readChatSessionProjectionScope(host, {
          sessionKey,
          agentId: prepared.agentId,
        });
        reduceChatSessionProjection(
          host,
          { type: "sendFailed", runId },
          { scope: projectionScope },
        );
        reconcileChatRunLifecycle(host, {
          outcome: "interrupted",
          sessionStatus: ack.status === "error" ? "failed" : "killed",
          runId: ack.runId,
          sessionKey,
          clearLocalRun: true,
          clearChatStream: true,
          clearToolStream: true,
          publishRunStatus: false,
          armLocalTerminalReconcile: ack.runId === runId,
        });
      }
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, error, {
        inline: storageMode === "durable" && !restoreCommand,
      });
      recordChatSendTiming(host, sendingItem, "failed", sendingItem.sendSubmittedAtMs, {
        error,
        ackStatus: ack.status,
      });
      return "failed";
    }
    const retireOnAck =
      storageMode === "memory" ||
      ack.messageSeq !== undefined ||
      (ack.status === "ok" && !requiresChatInputConsumption(prepared));
    let retirementFailed = false;
    if (retireOnAck) {
      removeQueuedMessageWithoutReleasing(host, id);
      retirementFailed = storageMode === "durable" && readQueuedMessageById(host, id) !== null;
    }
    if (isVisible()) {
      if (retireOnAck) {
        const projectionScope = readChatSessionProjectionScope(host, {
          sessionKey,
          agentId: prepared.agentId,
        });
        const projectedMessage = buildLocalUserMessage({
          ...prepared,
          text: message,
          mentions: submitted.mentions,
          attachments,
          createdAt: startedAt,
          runId,
        });
        if (projectedMessage) {
          reduceChatSessionProjection(
            host,
            { type: "sendPending", runId, message: projectedMessage },
            { scope: projectionScope },
          );
        }
        if (ack.runId !== runId) {
          reduceChatSessionProjection(
            host,
            { type: "sendAcknowledged", previousRunId: runId, runId: ack.runId },
            { scope: projectionScope },
          );
        }
      }
      if (ack.status === "ok") {
        reconcileChatRunLifecycle(host, {
          outcome: "done",
          sessionStatus: "done",
          runId: ack.runId,
          sessionKey,
          clearLocalRun: true,
          clearChatStream: true,
          clearToolStream: true,
          publishRunStatus: false,
          armLocalTerminalReconcile: true,
        });
        void loadChatHistory(host).then(() =>
          flushStoredChatOutbox(host, chatOutboxDrainDependencies),
        );
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        // Accepted steering/queued custody identifies the input, not a replacement
        // for the active model run. Only an explicit interrupt may replace it here;
        // otherwise live execution events own adoption when the queued turn starts.
        if (!host.chatRunId || prepared.queueMode === "interrupt") {
          adoptStartedChatRun(host, ack.runId, startedAt);
        }
        // Hydrate approved custody during setup without changing ordinary send
        // reconciliation or steering, whose ACK does not identify a new input.
        const setupHeld =
          prepared.sessionId &&
          host.sessionsResult?.sessions.some(
            (row) =>
              row.sessionId === prepared.sessionId &&
              ["requested", "provisioning", "syncing", "starting"].includes(
                row.placement?.state ?? "",
              ),
          );
        if (prepared.queueMode !== "steer" && ack.messageSeq === undefined && setupHeld) {
          void loadChatHistory(host, { deferBranches: true });
        }
      }
    }
    if (prepared.refreshSessions) {
      const target = { sessionKey, agentId: prepared.agentId };
      if (ack.status === "ok") {
        void refreshChatSessionListForTarget(host, target);
      } else if (isNonTerminalAgentRunStatus(ack.status)) {
        host.refreshSessionsAfterChat.set(ack.runId, target);
      }
    }
    discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
    if (retirementFailed) {
      surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
      return "pending";
    }
    return retireOnAck ? "sent" : "pending";
  } catch (err) {
    if (!requestConnectionIsCurrent()) {
      return "pending";
    }
    const restriction =
      err instanceof GatewayRequestError
        ? readAgentRuntimeRestrictionErrorDetails(err.details)
        : undefined;
    if (restriction) {
      const error = formatConnectError(err);
      // Keep the exact outbox input through confirmation; never retry a newer draft.
      finishScopedChatSending(host, scope);
      const failed = setState("failed", error);
      recordChatSendTiming(host, prepared, "failed", prepared.sendSubmittedAtMs, { error });
      const canRetry = allowNativeRecovery ? await recoverNativeRuntime?.(restriction) : undefined;
      if (canRetry?.() && requestConnectionIsCurrent() && isVisible()) {
        const current = readQueuedMessageById(host, id);
        if (!failed || !current || !sameQueuedDeliveryVersion(failed, current)) {
          return "failed";
        }
        const retry = updateQueuedSendItem(host, storageMode, id, (item) => ({
          ...item,
          sendRunId: generateUUID(),
          sendError: undefined,
          sessionId: restriction.recovery?.sessionId,
          sendState: "sending",
        }));
        if (retry) {
          return await sendQueuedChatMessage(
            host,
            id,
            { ...options, canDispatch: canRetry, allowActiveRunSend: true },
            queuedSessionKey,
            false,
          );
        }
      }
      const restored = restoreRejectedChatDelivery(host, prepared, options);
      surfaceChatDeliveryFailure(
        host,
        sessionKey,
        prepared.agentId,
        (isVisible() && host.chatError) || error,
        { inline: storageMode === "durable" && !restored },
      );
      return "failed";
    }
    return settleQueuedChatSendFailure(
      host,
      queued,
      prepared,
      err,
      options,
      scope,
      (retryDelayMs) =>
        scheduleStoredChatOutboxRetry(host, scope, retryDelayMs, chatOutboxDrainDependencies),
    );
  } finally {
    if (requestConnectionIsCurrent()) {
      finishScopedChatSending(host, scope);
    }
  }
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
          if (parked === "pending" && outbox.queue[0]?.id !== item.id) {
            // Reconcile older restored rows without delaying this turn's active-run policy.
            void scheduleOutboxDrain(host, outbox, chatOutboxDrainDependencies);
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
    if (options.restoreDraft && options.previousDraft?.trim()) {
      host.chatMessage = options.previousDraft;
      host.chatMentions = options.previousMentions ?? [];
    }
    if (options.restoreAttachments && options.previousAttachments?.length) {
      host.chatAttachments = options.previousAttachments;
    }
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
  async sendResetSlashCommand(host, message, options) {
    const pending = createPendingSendMessage(
      host,
      message,
      undefined,
      true,
      undefined,
      reconnectSafeQueuedSendState(host),
    );
    const item = pending?.item;
    if (item) {
      publishPendingSendMessage(host, item);
    }
    if (!pending || !admitQueuedMessageForSession(host, pending.admission, pending.item)) {
      if (item) {
        cancelChatDelivery(host, item, { previousDraft: options.previousDraft });
      }
      setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
      return;
    }
    await deliverChatQueueItem(host, pending.item, {
      previousDraft: options.previousDraft,
      restoreDraft: options.restoreDraft,
      routingSessionKey: host.sessionKey,
      target: options.target,
    });
  },
  setChatError,
};
