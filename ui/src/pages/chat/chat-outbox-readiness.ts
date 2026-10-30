import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentListParamsForRefreshTarget,
  visibleSessionMatches,
} from "../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { CHAT_OUTBOX_RETRY_DEFAULT_MS, retryableGatewayDelayMs } from "./chat-outbox-retry.ts";
import {
  clearPendingQueueItemsForRun,
  readQueuedMessageById,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  chatSendHoldReason,
  OFFLINE_QUEUE_STORAGE_ERROR,
  surfaceChatDeliveryFailure,
} from "./chat-send-support.ts";
import { formatConnectError } from "./connect-error.ts";
import { isChatBusy, reconcileChatRunFromSessionRow } from "./run-lifecycle.ts";

/** Check idle readiness for unsent input; attempted sends reconcile at admission. */
export async function reconcileStoredChatOutboxHead(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  client: NonNullable<ChatHost["client"]>,
  connectionEpoch: number | undefined,
  scheduleRetry: (delayMs: number) => void,
  reconcileActiveRun = false,
): Promise<"blocked" | "continue" | "send"> {
  if (item.sendAttempts || item.sendRequestStartedAtMs !== undefined || item.queueMode) {
    return "send";
  }
  if (!reconcileActiveRun) {
    const row =
      !isUiGlobalSessionKey(outbox.sessionKey) || host.sessions.state.agentId === outbox.agentId
        ? host.sessions.state.result?.sessions.find((session) =>
            areUiSessionKeysEquivalent(session.key, outbox.sessionKey),
          )
        : undefined;
    if (row && isSessionRunStateActive(row)) {
      return "blocked";
    }
  }
  const runId = host.chatRunId;
  const runGeneration = host.chatRunLifecycleGeneration;
  const sessionId = host.currentSessionId;
  const sessions = host.sessions;
  const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
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
  const observation =
    visible && runId && sessionId && recoveryAgentId
      ? sessions.observeRow({ key: outbox.sessionKey, agentId: recoveryAgentId }, () => {})
      : undefined;
  const reconcile = observation?.captureReconcile();
  const isCurrent = () =>
    host.client === client &&
    host.connectionEpoch === connectionEpoch &&
    host.connected &&
    !chatSendHoldReason(host, outbox.sessionKey, false, outbox.agentId);
  const ownsRecovery = () =>
    isCurrent() &&
    host.sessions === sessions &&
    host.currentSessionId === sessionId &&
    readRecoveryAgentId() === recoveryAgentId &&
    visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
  try {
    const history = await client.request<ChatHistoryResult>(
      "chat.history",
      {
        sessionKey: outbox.sessionKey,
        ...(isUiGlobalSessionKey(outbox.sessionKey) && outbox.agentId
          ? { agentId: outbox.agentId }
          : {}),
        limit: 1,
      },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    if (!isCurrent()) {
      return "blocked";
    }
    const current = readQueuedMessageById(host, item.id);
    if (!current || !sameQueuedDeliveryVersion(current, item)) {
      return "continue";
    }
    const row = history.sessionInfo;
    if (item.sessionId && item.sessionId !== (row?.sessionId ?? history.sessionId)) {
      const error = "The conversation changed. Review this message before retrying.";
      updateQueuedMessage(host, item.id, (entry) => ({
        ...entry,
        sendState: "failed",
        sendError: error,
      }));
      surfaceChatDeliveryFailure(host, outbox.sessionKey, outbox.agentId, error);
      return "blocked";
    }
    if (!row || row.hasActiveRun === true || isSessionRunStateActive(row)) {
      return "blocked";
    }
    const targetSessionId = row.sessionId ?? history.sessionId;
    // Background sends have no visible pane to bind their first attempt.
    if (
      !item.sessionId &&
      targetSessionId &&
      !updateQueuedMessage(host, item.id, (entry) => ({ ...entry, sessionId: targetSessionId }))
    ) {
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        OFFLINE_QUEUE_STORAGE_ERROR,
      );
      return "blocked";
    }
    if (
      reconcile &&
      runId &&
      row.lastRunId === runId &&
      row.sessionId === sessionId &&
      ownsRecovery() &&
      host.chatRunId === runId &&
      host.chatRunLifecycleGeneration === runGeneration &&
      visibleSessionMatches(host, outbox.sessionKey, outbox.agentId)
    ) {
      const result = reconcile(row);
      if (
        !ownsRecovery() ||
        result.status !== "current" ||
        !result.row ||
        result.row.sessionId !== sessionId ||
        result.row.lastRunId !== runId ||
        result.row.hasActiveRun === true ||
        isSessionRunStateActive(result.row)
      ) {
        return "blocked";
      }
      if (
        host.chatRunId === runId &&
        host.chatRunLifecycleGeneration === runGeneration &&
        !reconcileChatRunFromSessionRow(host, result.row, { publishRunStatus: false })
      ) {
        return "blocked";
      }
      if (!ownsRecovery()) {
        return "blocked";
      }
      clearPendingQueueItemsForRun(host, runId);
    }
    return visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && isChatBusy(host)
      ? "blocked"
      : "send";
  } catch (error) {
    if (!isCurrent()) {
      return "blocked";
    }
    const current = readQueuedMessageById(host, item.id);
    if (!current || !sameQueuedDeliveryVersion(current, item)) {
      return "continue";
    }
    const delay =
      error instanceof GatewayProtocolRequestTimeoutError
        ? CHAT_OUTBOX_RETRY_DEFAULT_MS
        : retryableGatewayDelayMs(error);
    if (delay !== null) {
      scheduleRetry(delay);
    } else if (error instanceof GatewayRequestError) {
      const message = formatConnectError(error);
      const retained = updateQueuedMessage(host, item.id, (entry) => ({
        ...entry,
        sendState: "failed",
        sendError: message,
      }));
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        retained ? message : OFFLINE_QUEUE_STORAGE_ERROR,
      );
      return retained ? "continue" : "blocked";
    }
    return "blocked";
  } finally {
    observation?.dispose();
  }
}
