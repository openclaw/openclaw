import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import type { SessionScopeHost } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  isVolatileQueuedMessage,
  updateQueuedMessage,
  updateVolatileQueuedMessage,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueScopedSessionHost) {
  const items = chatOutboxOwner(host).allItems(host);
  for (const item of items) {
    if (
      !item.sendRunId ||
      (item.sendState !== "submitting" &&
        item.sendState !== "sending" &&
        item.sendState !== "waiting-idle")
    ) {
      continue;
    }
    // An unsent row held by an editor cannot be in flight. Keep its captured
    // version valid; the drain still reconciles it after the edit is released.
    if (
      item.sendState === "waiting-idle" &&
      item.sendAttempts === 0 &&
      item.sendRequestStartedAtMs === undefined &&
      isQueuedMessageBeingEdited(host, item.id)
    ) {
      continue;
    }
    if (isVolatileQueuedMessage(host, item.id)) {
      updateVolatileQueuedMessage(host, item.id, (current) => ({
        ...current,
        sendState: "unconfirmed",
      }));
      continue;
    }
    updateQueuedMessage(host, item.id, (current) => ({
      ...current,
      sendState: "waiting-reconnect",
    }));
  }
}

type ChatIdleSessionReconciliationHost = SessionScopeHost & {
  chatQueue: unknown[];
  sessionKey: string;
  sessionsError?: string | null;
  sessionsResult?: SessionsListResult | null;
};

function isSelectedSessionKnownIdle(
  sessionsResult: SessionsListResult,
  sessionKey: string,
): boolean {
  const row = sessionsResult.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  return Boolean(row && !isSessionRunActive(row));
}

function isHistorySessionInfoForRequestedSession(
  host: ChatIdleSessionReconciliationHost,
  historySessionKey: string | undefined,
  requestedSessionKey: string,
): boolean {
  if (areUiSessionKeysEquivalent(historySessionKey, requestedSessionKey)) {
    return true;
  }
  return Boolean(
    historySessionKey &&
    isUiGlobalSessionKey(historySessionKey) &&
    resolveUiGlobalAliasAgentId(host, requestedSessionKey),
  );
}

function findSelectedSessionRow(
  host: ChatIdleSessionReconciliationHost,
  sessionsResult: SessionsListResult | null | undefined,
  sessionKey: string,
  historySessionKey: string | undefined,
): GatewaySessionRow | undefined {
  const requestedGlobalAgentId =
    historySessionKey && isUiGlobalSessionKey(historySessionKey)
      ? resolveUiGlobalAliasAgentId(host, sessionKey)
      : undefined;
  return sessionsResult?.sessions.find((session) => {
    if (areUiSessionKeysEquivalent(session.key, sessionKey)) {
      return true;
    }
    return (
      requestedGlobalAgentId != null &&
      resolveUiGlobalAliasAgentId(host, session.key) === requestedGlobalAgentId
    );
  });
}

function historyIdleProofIsStaleForSelectedRow(
  historySessionInfo: GatewaySessionRow,
  selectedRow: GatewaySessionRow | undefined,
): boolean {
  if (!selectedRow || !isSessionRunActive(selectedRow) || isSessionRunActive(historySessionInfo)) {
    return false;
  }
  const historyUpdatedAt =
    typeof historySessionInfo.updatedAt === "number" ? historySessionInfo.updatedAt : null;
  if (historyUpdatedAt == null) {
    return true;
  }
  const selectedUpdatedAt = typeof selectedRow.updatedAt === "number" ? selectedRow.updatedAt : 0;
  if (selectedUpdatedAt >= historyUpdatedAt) {
    return true;
  }
  const selectedStartedAt = typeof selectedRow.startedAt === "number" ? selectedRow.startedAt : 0;
  return selectedStartedAt >= historyUpdatedAt;
}

export function flushChatQueueAfterIdleSessionReconciliation(
  host: ChatIdleSessionReconciliationHost,
  sessionKey: string,
  historyRefresh: Promise<ChatHistoryResult | undefined>,
  sessionsRefresh: Promise<unknown>,
  previousSessionsResult: SessionsListResult | null | undefined,
  flushQueue: () => void,
) {
  void Promise.allSettled([historyRefresh, sessionsRefresh]).then((results) => {
    const historyRefreshSettled = results[0];
    const sessionsRefreshSettled = results[1];
    const freshSessionsResult = host.sessionsResult;
    const historySessionInfo =
      historyRefreshSettled.status === "fulfilled"
        ? historyRefreshSettled.value?.sessionInfo
        : null;
    const selectedSessionRow = findSelectedSessionRow(
      host,
      freshSessionsResult,
      sessionKey,
      historySessionInfo?.key,
    );
    const historySessionKnownIdle = Boolean(
      historySessionInfo &&
      isHistorySessionInfoForRequestedSession(host, historySessionInfo.key, sessionKey) &&
      !isSessionRunActive(historySessionInfo) &&
      !historyIdleProofIsStaleForSelectedRow(historySessionInfo, selectedSessionRow),
    );
    const sessionsResultKnownIdle = freshSessionsResult
      ? isSelectedSessionKnownIdle(freshSessionsResult, sessionKey)
      : false;
    if (
      sessionsRefreshSettled.status !== "fulfilled" ||
      host.chatQueue.length === 0 ||
      !areUiSessionKeysEquivalent(host.sessionKey, sessionKey) ||
      (!freshSessionsResult && !historySessionKnownIdle) ||
      (freshSessionsResult === previousSessionsResult && !historySessionKnownIdle) ||
      (host.sessionsError && !historySessionKnownIdle) ||
      !(historySessionKnownIdle || sessionsResultKnownIdle)
    ) {
      return;
    }
    flushQueue();
  });
}
