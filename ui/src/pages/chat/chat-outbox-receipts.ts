import { CHAT_INPUT_RUN_ID_MAX_CHARS } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  findChatSubmissionMessage,
  readChatInputReceipt,
} from "../../lib/chat/history-message-identity.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import {
  readStoredChatOutbox,
  type StoredChatOutbox,
} from "../../lib/chat/outbox-store-projection.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentListParamsForRefreshTarget,
  visibleSessionMatches,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { retryableGatewayDelayMs } from "./chat-outbox-retry.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import {
  clearPendingQueueItemsForRun,
  confirmQueuedMessageCustody,
  removeDeliveredQueuedChatSendForRun,
  syncVisibleChatQueueProjection,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  OFFLINE_QUEUE_STORAGE_ERROR,
  UNCONFIRMED_CHAT_SEND_ERROR,
  retireDeliveredQueuedUserTurn,
  requiresChatInputConsumption,
  surfaceChatDeliveryFailure,
} from "./chat-send-support.ts";
import { formatConnectError } from "./connect-error.ts";
import { reconcileChatRunFromSessionRow } from "./run-lifecycle.ts";

export function isInterruptedChatInput(history: ChatHistoryResult, item: ChatQueueItem): boolean {
  return (
    readChatInputReceipt(history, item) === "pending" &&
    history.pendingInputs?.items.some(
      (input) => input.runId === item.sendRunId && input.state === "interrupted",
    ) === true
  );
}

/** Reconcile exact pending custody before considering transcript consumption. */
function reconcilePendingChatOutboxInput(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  history: ChatHistoryResult,
  pendingBefore: number | undefined,
): ChatHistoryResult | "blocked" | "continue" | undefined {
  const historySessionId = history.sessionInfo?.sessionId ?? history.sessionId;
  if (item.sessionId && item.sessionId !== historySessionId) {
    // Request ids are scoped to their physical session. A replacement's matching
    // id cannot consume an old input or authorize sending it into the new chat.
    if (item.sendState !== "unconfirmed" || item.sendError !== UNCONFIRMED_CHAT_SEND_ERROR) {
      const parked = updateQueuedMessage(host, item.id, (entry) => ({
        ...entry,
        sendState: "unconfirmed",
        sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      }));
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        parked ? UNCONFIRMED_CHAT_SEND_ERROR : OFFLINE_QUEUE_STORAGE_ERROR,
      );
    }
    return "blocked";
  }
  const inputReceipt = readChatInputReceipt(history, item);
  if (inputReceipt === "pending") {
    const pending = history.pendingInputs?.items.find((input) => input.runId === item.sendRunId);
    const confirmsLocal = Boolean(
      pending?.state !== "cancelled" &&
      historySessionId &&
      (!item.sessionId || item.sendState === "unconfirmed"),
    );
    if (confirmsLocal && !confirmQueuedMessageCustody(host, item, historySessionId)) {
      return "blocked";
    }
    if (
      visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) &&
      historySessionId === host.currentSessionId &&
      pendingBefore === undefined
    ) {
      applyChatPendingInputs(host, history.pendingInputs);
    }
    if (pending?.state === "cancelled") {
      return removeDeliveredQueuedChatSendForRun(host, item.sendRunId, outbox) !== null ||
        !readStoredChatOutbox(host, outbox)?.queue.some((entry) => entry.id === item.id)
        ? "continue"
        : "blocked";
    }
    if (confirmsLocal) {
      return "continue";
    }
    // Only positive unconsumed custody can cross a restart. The new request
    // acquires current authority; an absent receipt is still an uncertain send.
    return pending?.state === "interrupted" &&
      item.sendState !== "sending" &&
      history.sessionInfo &&
      (item.queueMode === "steer" ||
        item.queueMode === "interrupt" ||
        // Recovery can own the session while its runner waits for capacity.
        // Queued input must not enter that interrupted turn's model context.
        (history.sessionInfo.hasActiveRun !== true &&
          history.sessionInfo.status !== "running" &&
          history.sessionInfo.status !== "queued"))
      ? history
      : "blocked";
  }
  return undefined;
}

function sessionRunProvesQueuedDelivery(
  sessionInfo: ChatHistoryResult["sessionInfo"],
  item: ChatQueueItem,
): boolean {
  return Boolean(
    item.sendRunId &&
    (sessionInfo?.activeRunIds?.includes(item.sendRunId) ||
      sessionInfo?.lastRunId === item.sendRunId),
  );
}

export async function readCurrentStoredChatHistory(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  client: NonNullable<ChatHost["client"]>,
  connectionEpoch: number | undefined,
  scheduleRetry: (delayMs: number) => void,
): Promise<ChatHistoryResult | "blocked" | "continue"> {
  const runId = host.chatRunId;
  const runGeneration = host.chatRunLifecycleGeneration;
  const sessionId = host.currentSessionId;
  const sessions = host.sessions;
  const readRecoveryAgentId = () => {
    if (outbox.agentId || isUiGlobalSessionKey(outbox.sessionKey)) {
      return outbox.agentId;
    }
    const held = sessionId
      ? host.sessionsResult?.sessions.find(
          (row) =>
            row.sessionId === sessionId && areUiSessionKeysEquivalent(row.key, outbox.sessionKey),
        )
      : undefined;
    // A retained literal key can belong to a different agent than today's default.
    return scopedAgentListParamsForRefreshTarget(host, {
      sessionKey: outbox.sessionKey,
      agentId: held?.agentId ?? (held ? (host.sessionsResultAgentId ?? undefined) : undefined),
    }).agentId;
  };
  const recoveryAgentId = readRecoveryAgentId();
  const recoveryObservation =
    runId &&
    sessionId &&
    recoveryAgentId &&
    visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)
      ? sessions.observeRow({ key: outbox.sessionKey, agentId: recoveryAgentId }, () => {})
      : undefined;
  const reconcileRecovery = recoveryObservation?.captureReconcile();
  const isCurrent = () =>
    host.client === client && host.connectionEpoch === connectionEpoch && host.connected;
  const isRecoveryCurrent = () =>
    isCurrent() &&
    host.sessions === sessions &&
    host.currentSessionId === sessionId &&
    readRecoveryAgentId() === recoveryAgentId &&
    visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
  try {
    let history: ChatHistoryResult;
    let pendingBefore: number | undefined;
    const request = {
      sessionKey: outbox.sessionKey,
      ...(isUiGlobalSessionKey(outbox.sessionKey) && outbox.agentId
        ? { agentId: outbox.agentId }
        : {}),
      ...(item.sendRunId && item.sendRunId.length <= CHAT_INPUT_RUN_ID_MAX_CHARS
        ? { inputRunIds: [item.sendRunId] }
        : {}),
    };
    try {
      history = await client.request<ChatHistoryResult>("chat.history", {
        ...request,
        limit: 1000,
      });
      // Custody receipts are exact but display pages contain only twenty inputs.
      // Follow their bounded cursor instead of stranding an older accepted head.
      while (
        readChatInputReceipt(history, item) === "pending" &&
        !history.pendingInputs?.items.some((input) => input.runId === item.sendRunId) &&
        history.pendingInputs?.nextBefore !== undefined &&
        (pendingBefore === undefined || history.pendingInputs.nextBefore < pendingBefore)
      ) {
        if (!isCurrent()) {
          return "blocked";
        }
        pendingBefore = history.pendingInputs.nextBefore;
        history = await client.request<ChatHistoryResult>("chat.history", {
          ...request,
          limit: 20,
          pendingBefore,
        });
      }
    } catch (err) {
      const retryDelayMs = retryableGatewayDelayMs(err);
      if (retryDelayMs !== null) {
        if (isCurrent()) {
          scheduleRetry(retryDelayMs);
        }
        return "blocked";
      }
      // Fail or park non-retryable rejections visibly so they cannot silently block FIFO.
      if (!isCurrent() || !(err instanceof GatewayRequestError)) {
        return "blocked";
      }
      const current = readStoredChatOutbox(host, outbox)?.queue.find(
        (entry) => entry.id === item.id,
      );
      if (!current || !sameQueuedDeliveryVersion(current, item)) {
        return "blocked";
      }
      const attempted =
        (item.sendAttempts ?? 0) > 0 ||
        item.sendRequestStartedAtMs !== undefined ||
        item.sendState === "unconfirmed";
      const error = attempted ? UNCONFIRMED_CHAT_SEND_ERROR : formatConnectError(err);
      const targetState = attempted ? ("unconfirmed" as const) : ("failed" as const);
      if (item.sendState === targetState && item.sendError === error) {
        return "blocked";
      }
      const parked = updateQueuedMessage(host, item.id, (entry) => ({
        ...entry,
        sendError: error,
        sendState: targetState,
      }));
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        parked ? error : OFFLINE_QUEUE_STORAGE_ERROR,
        // Attempted messages own their inline error; other failures need the banner.
        { inline: Boolean(parked && attempted && !item.localCommandName) },
      );
      return parked && !attempted ? "continue" : "blocked";
    }
    const currentOutbox = readStoredChatOutbox(host, outbox);
    const currentItem = currentOutbox?.queue.find((entry) => entry.id === item.id);
    if (!isCurrent()) {
      return "blocked";
    }
    if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
      return "continue";
    }
    syncVisibleChatQueueProjection(host);
    const pendingInput = reconcilePendingChatOutboxInput(
      host,
      outbox,
      item,
      history,
      pendingBefore,
    );
    if (pendingInput !== undefined) {
      return pendingInput;
    }
    const inputReceipt = readChatInputReceipt(history, item);
    // Ordinary chat needs input consumption; command lifecycle receipts retain
    // their separate contract when no user transcript message is produced.
    if (
      inputReceipt ||
      findChatSubmissionMessage(
        history.messages,
        item.sendRunId,
        requiresChatInputConsumption(item),
      ) ||
      (!requiresChatInputConsumption(item) &&
        sessionRunProvesQueuedDelivery(history.sessionInfo, item))
    ) {
      const retired =
        (await retireDeliveredQueuedUserTurn(host, item.sendRunId, outbox, {
          inputConsumed: requiresChatInputConsumption(item),
        })) === "retired";
      if (!retired || !isCurrent()) {
        return "blocked";
      }
      if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)) {
        void loadChatHistory(host, {
          supersedeInFlight: Boolean(inputReceipt),
        });
      }
      return "continue";
    }
    if (
      !history.sessionInfo ||
      history.sessionInfo.hasActiveRun === true ||
      isSessionRunActive(history.sessionInfo)
    ) {
      return "blocked";
    }
    if (
      reconcileRecovery &&
      runId &&
      host.chatRunId === runId &&
      host.chatRunLifecycleGeneration === runGeneration &&
      history.sessionInfo.lastRunId === runId &&
      sessionId &&
      history.sessionInfo.sessionId === sessionId &&
      isRecoveryCurrent()
    ) {
      const current = reconcileRecovery(history.sessionInfo);
      if (
        !isRecoveryCurrent() ||
        current.status !== "current" ||
        !current.row ||
        current.row.sessionId !== sessionId ||
        current.row.lastRunId !== runId ||
        current.row.hasActiveRun === true ||
        isSessionRunActive(current.row)
      ) {
        return "blocked";
      }
      // Shared publication may already settle this run or start its successor.
      // Only the captured run's pending input belongs to this terminal receipt.
      if (
        host.chatRunId === runId &&
        host.chatRunLifecycleGeneration === runGeneration &&
        !reconcileChatRunFromSessionRow(host, current.row, { publishRunStatus: false })
      ) {
        return "blocked";
      }
      if (!isRecoveryCurrent()) {
        return "blocked";
      }
      clearPendingQueueItemsForRun(host, runId);
    }
    return history;
  } finally {
    recoveryObservation?.dispose();
  }
}
