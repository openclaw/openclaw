import { readSessionProjectionFinalMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { pruneMapToMaxSize } from "../../../../src/infra/map-size.ts";
import { projectAssistantDisplayContent } from "../../../../src/shared/assistant-display-content.js";
import { getOrCreateWeakOwnerMap } from "../../../../src/shared/weak-owner-map.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { pickFreshestObserverDigest } from "../../lib/observer-digest.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { selectedGlobalEventAgentId } from "./chat-agent-id.ts";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  pullRequestLinksIn,
  refreshPullRequestsForFinalReply,
  refreshPullRequestsForStreamedLinks,
} from "./chat-pull-request-refresh.ts";
import { clearPendingQueueItemsForRun, readDeliveredQueuedChatSendForRun } from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import {
  requiresChatInputConsumption,
  retireDeliveredQueuedUserTurn,
} from "./chat-send-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatModelAuthStatus } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  refreshSessionWorkspace,
  retireSessionWorkspaceCheckout,
} from "./components/chat-session-workspace.ts";
import { getChatSessionProjection, readChatSessionProjectionScope } from "./history-merge.ts";
import { captureOutboxPayloadOwner } from "./outbox-payloads.ts";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";
import { handleSessionOperationEvent } from "./tool-stream-status.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type ChatPanePresentation = () => boolean;
const MAX_REMEMBERED_TERMINAL_RECOVERY_CLAIMS = 64;
function refreshChatEventHistory(
  state: ChatPageHost,
  presented: boolean,
  supersedeInFlight?: true,
): void {
  void loadChatHistory(state, {
    deferBranches: !presented,
    ...(supersedeInFlight ? { supersedeInFlight } : {}),
  });
}

function replayPendingSessionMessageReload(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
  presentation: ChatPanePresentation,
): boolean {
  const pendingSessionKey = state.pendingSessionMessageReloadSessionKey;
  const payloadSessionKey = payload?.sessionKey?.trim();
  if (
    !pendingSessionKey ||
    !payloadSessionKey ||
    !areUiSessionKeysEquivalent(pendingSessionKey, payloadSessionKey) ||
    !areUiSessionKeysEquivalent(payloadSessionKey, state.sessionKey) ||
    state.chatRunId
  ) {
    return false;
  }
  state.pendingSessionMessageReloadSessionKey = null;
  refreshChatEventHistory(state, presentation());
  return true;
}

const terminalRecoveryClaimsByPane = new WeakMap<object, Map<string, true>>();

function claimTerminalRecovery(state: ChatPageHost, runId: string): boolean {
  const claims = getOrCreateWeakOwnerMap(terminalRecoveryClaimsByPane, state);
  if (claims.has(runId)) {
    return false;
  }
  claims.set(runId, true);
  pruneMapToMaxSize(claims, MAX_REMEMBERED_TERMINAL_RECOVERY_CLAIMS);
  return true;
}

function finalAssistantReplyHasPullRequestLink(
  state: ChatPageHost,
  payload: ChatEventPayload | undefined,
): boolean {
  if (
    payload?.state !== "final" ||
    !visibleSessionMatches(state, payload.sessionKey, payload.agentId)
  ) {
    return false;
  }
  const finalText = extractText(payload.message);
  const streamTexts =
    typeof payload.runId === "string" && payload.runId === state.chatRunId
      ? [state.chatStream, ...(state.chatStreamSegments ?? []).map((segment) => segment.text)]
      : [];
  const isVisible = (text: string | null | undefined) =>
    typeof text === "string" && text.trim().length > 0 && !isHiddenAssistantStreamText(text);
  return (
    ((isVisible(finalText) && !isAssistantHeartbeatAckForDisplay(payload.message)) ||
      streamTexts.some(isVisible)) &&
    [finalText, ...streamTexts].some((text) => pullRequestLinksIn(text).length > 0)
  );
}

function observerDigestMatchesAuthoritativeRun(
  state: ChatPageHost,
  digest: SessionObserverDigest,
): boolean {
  if (state.chatRunId) {
    return digest.runId === state.chatRunId;
  }
  const session = selectedChatSessionRow(state);
  return Boolean(
    session?.hasActiveRun && digest.runId && session.activeRunIds?.includes(digest.runId),
  );
}

export function handleChatLiveEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: ChatPanePresentation = () => true,
): void {
  const frameBatched =
    event.event === "agent" ||
    event.event === "session.tool" ||
    event.event === "session.operation" ||
    (event.event === "chat" && asNullableRecord(event.payload)?.state === "delta");
  chatRunPresentation(state).batch(
    () => applyPageGatewayEvent(state, event, isPresented),
    frameBatched ? "animation-frame" : "immediate",
  );
}

function applyPageGatewayEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: ChatPanePresentation,
): void {
  if (event.event === "chat") {
    // SAFETY: Gateway chat payload; its reducer checks run/session identity and normalizes content.
    const payload = event.payload as ChatEventPayload | undefined;
    const terminalPayload =
      payload &&
      (payload.state === "final" || payload.state === "aborted" || payload.state === "error")
        ? payload
        : undefined;
    const apply = () =>
      chatRunPresentation(state).batch(
        () => {
          const sessionMatches = Boolean(
            payload && visibleSessionMatches(state, payload.sessionKey, payload.agentId),
          );
          const finalMessage =
            payload?.state === "final" ? asNullableRecord(payload.message) : null;
          // Retired source text can remain on the wire with an empty display projection.
          // Like an omitted final, it still needs the durable reply if publication was missed.
          const recoveryRunId =
            (payload?.state === "error" ||
              (payload?.state === "final" &&
                (!finalMessage ||
                  !readSessionProjectionFinalMessageIdentity(
                    projectAssistantDisplayContent(finalMessage),
                  )))) &&
            sessionMatches &&
            typeof payload.runId === "string" &&
            (!state.chatRunId || state.chatRunId === payload.runId)
              ? payload.runId
              : null;
          const recoveryScope = recoveryRunId ? readChatSessionProjectionScope(state) : null;
          if (
            payload?.state === "delta" &&
            typeof payload.runId === "string" &&
            sessionMatches &&
            // Same-session background streams cannot clear the foreground run's status.
            (!state.chatRunId || state.chatRunId === payload.runId) &&
            state.observerDigest &&
            state.observerDigest.runId !== payload.runId
          ) {
            state.observerDigest = null;
          }
          if (
            payload?.state === "delta" &&
            typeof payload.deltaText === "string" &&
            sessionMatches
          ) {
            refreshPullRequestsForStreamedLinks(state, payload.runId, payload.deltaText);
          }
          const shouldRefreshPullRequests = finalAssistantReplyHasPullRequestLink(state, payload);
          if (handleChatGatewayEvent(state, payload) === "injected") {
            chatRunPresentation(state).publish();
            return;
          }
          if (terminalPayload && sessionMatches) {
            clearPendingQueueItemsForRun(state, terminalPayload.runId);
            // Refresh stale usage after a run; split panes share the Gateway deadline.
            void refreshChatModelAuthStatus(state, terminalPayload.runId);
          }
          if (shouldRefreshPullRequests && payload) {
            refreshPullRequestsForFinalReply(state, payload.runId, payload.message);
          }
          const shouldRecoverMissingTerminal = Boolean(
            recoveryRunId &&
            recoveryScope &&
            (payload?.state === "error"
              ? state.chatRunError?.runId === recoveryRunId
              : getChatSessionProjection(state, recoveryScope).runs[recoveryRunId]?.status ===
                "completed"),
          );
          if (
            shouldRecoverMissingTerminal &&
            recoveryRunId &&
            claimTerminalRecovery(state, recoveryRunId)
          ) {
            state.pendingSessionMessageReloadSessionKey = null;
            // A final persisted after this read catches up through session events or Refresh.
            // The history owner already rejects results for a replaced connection/session.
            refreshChatEventHistory(state, isPresented(), true);
          } else {
            replayPendingSessionMessageReload(state, payload, isPresented);
          }
          if (terminalPayload) {
            void resumeStoredChatOutboxes(state, event);
            if (sessionMatches) {
              if (isPresented()) {
                refreshSessionWorkspace(
                  state,
                  isSidebarSlotVisible(state.sidebarLayout, "workspace"),
                );
              } else {
                retireSessionWorkspaceCheckout(state);
              }
            }
          }
          if (sessionMatches) {
            chatRunPresentation(state).publish(
              payload?.state === "delta" ? "animation-frame" : "immediate",
              payload?.state !== "delta",
            );
          }
        },
        payload?.state === "delta" ? "animation-frame" : "immediate",
      );
    if (!terminalPayload) {
      apply();
      return;
    }
    // A cold Blob read may finish after another connection or retry takes over.
    // Apply the terminal only after its complete user turn owns independent bytes.
    const scope = resolveUiConversationIdentity(
      state,
      terminalPayload.sessionKey,
      isUiGlobalSessionKey(terminalPayload.sessionKey)
        ? selectedGlobalEventAgentId(state, terminalPayload.agentId ?? null)
        : terminalPayload.agentId,
    );
    const connectionEpoch = state.connectionEpoch;
    const queued = readDeliveredQueuedChatSendForRun(state, terminalPayload.runId, scope);
    const ownerIsCurrent = captureOutboxPayloadOwner(state);
    // Keep the complete user display pinned before applying the terminal, but
    // ordinary input retains its durable retry bytes until consumption is proven.
    const retirement = retireDeliveredQueuedUserTurn(state, terminalPayload.runId, scope, {
      retainUntilConsumed: Boolean(queued && requiresChatInputConsumption(queued)),
    });
    const finish = (outcome: Awaited<typeof retirement>) => {
      if (outcome !== "stale" && state.connectionEpoch === connectionEpoch && ownerIsCurrent()) {
        apply();
      }
    };
    if (retirement instanceof Promise) {
      void retirement.then(finish);
      return;
    }
    finish(retirement);
    return;
  }
  if (event.event === "session.observer") {
    // SAFETY: Protocol observer digest; the checks below admit only this session and its active run.
    const payload = event.payload as SessionObserverDigest | undefined;
    if (
      !payload ||
      !visibleSessionMatches(state, payload.sessionKey, payload.agentId) ||
      !observerDigestMatchesAuthoritativeRun(state, payload)
    ) {
      return;
    }
    const previous = state.observerDigest;
    if (
      previous?.runId === payload.runId &&
      pickFreshestObserverDigest(previous, payload) === previous
    ) {
      return;
    }
    state.observerDigest = payload;
    chatRunPresentation(state).publish();
    return;
  }
  if (event.event === "agent" || event.event === "session.tool") {
    // SAFETY: AgentEvent streams; the reducer checks session, sequence, and stream-specific data.
    const payload = event.payload as AgentEventPayload | undefined;
    const knownToolActivity =
      (payload?.stream === "tool" || payload?.stream === "item") &&
      state.knownAgentRunIds?.has(payload.runId);
    if (handleAgentEvent(state, payload)) {
      // Tool messages publish at their flush; first observed activity still wakes the pane.
      chatRunPresentation(state).publish("animation-frame", !knownToolActivity);
    }
    return;
  }
  if (event.event === "session.operation") {
    handleSessionOperationEvent(
      state,
      // SAFETY: Protocol operation event; its reducer checks the operation, session, and phase.
      event.payload as Parameters<typeof handleSessionOperationEvent>[1],
    );
    chatRunPresentation(state).publish("animation-frame");
  }
}
