import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { isChatQueuePaused } from "./chat-queue-pause.ts";
import { clearChatQueue, resumeChatQueue } from "./chat-send-actions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view-frame.ts";

registerChatSessionEnglish();

/** Share the session pause between the composer queue controls and the exact Resume action. */
export function createChatPaneRecoveryActions(
  state: ChatPageHost,
  row: GatewaySessionRow | undefined,
  scope: {
    paused: boolean;
    participationBlocked: boolean;
    canResume: boolean;
    connectionGeneration: number;
    isCurrent: () => boolean;
  },
): Pick<
  ChatProps,
  | "nativeRecovery"
  | "onQueueRemove"
  | "queuePaused"
  | "onQueueResume"
  | "onQueueClear"
  | "onQueueRetry"
  | "onQueueSteer"
  | "onQueueMove"
  | "onToggleRealtimeTalk"
> {
  const { paused, participationBlocked } = scope;
  const runId = row?.nativeRecoveryHeldRunId;
  const sessionId = row?.sessionId;
  const client = state.client;
  const selectedKey = state.sessionKey;
  const selectedAgentId = resolveChatAgentId(state);
  const isCurrent = () =>
    scope.isCurrent() &&
    state.client === client &&
    state.sessionKey === selectedKey &&
    resolveChatAgentId(state) === selectedAgentId &&
    selectedChatSessionRow(state)?.sessionId === sessionId;
  return {
    nativeRecovery:
      row && runId && sessionId && !row.archived
        ? {
            key: JSON.stringify([scope.connectionGeneration, sessionId, runId]),
            onResume:
              state.connected && client && scope.canResume && !participationBlocked
                ? async () => {
                    if (
                      !isCurrent() ||
                      selectedChatSessionRow(state)?.nativeRecoveryHeldRunId !== runId
                    ) {
                      return;
                    }
                    const agentId = row.agentId ?? selectedAgentId;
                    try {
                      const response = await client.request<{ queueReleased: boolean }>(
                        "sessions.nativeRecovery.resume",
                        { sessionKey: row.key, agentId, sessionId, runId },
                      );
                      if (isCurrent() && !response.queueReleased) {
                        state.lastError = t("chat.nativeRecovery.queued");
                      }
                    } catch {
                      if (isCurrent()) {
                        state.lastError = t("chat.nativeRecovery.unconfirmed");
                      }
                    } finally {
                      if (isCurrent()) {
                        const reconcile = state.sessions.captureReconcile();
                        const refreshed = await state.sessions
                          .describe({ key: row.key, agentId }, { client, refresh: true })
                          .catch(() => undefined);
                        const current = refreshed?.session;
                        if (current && isCurrent() && current.sessionId === sessionId) {
                          reconcile({
                            ...current,
                            nativeRecoveryHeldRunId: current.nativeRecoveryHeldRunId ?? null,
                          });
                        }
                      }
                    }
                  }
                : undefined,
          }
        : undefined,
    onToggleRealtimeTalk: () => (paused ? undefined : void state.toggleRealtimeTalk()),
    onQueueRemove: state.removeQueuedMessage,
    queuePaused: isChatQueuePaused(state),
    onQueueResume: paused ? undefined : () => resumeChatQueue(state),
    onQueueClear: () => clearChatQueue(state),
    onQueueRetry: paused ? undefined : (id) => void state.retryQueuedChatMessage(id),
    onQueueSteer:
      participationBlocked || paused ? undefined : (id) => void state.steerQueuedChatMessage(id),
    onQueueMove: participationBlocked ? undefined : state.moveQueuedChatMessage,
  };
}
