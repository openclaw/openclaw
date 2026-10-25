import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiGlobalAliasAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import type { SessionChangedRowResult } from "../../lib/sessions/session-row-reconcile.ts";
import { selectedGlobalEventAgentId } from "./chat-agent-id.ts";
import { invalidateChatBranches, loadChatBranches } from "./chat-history-branches.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  dispatchChatLiveEvent,
  isChatLiveEvent,
  retirePendingChatLiveEvents,
} from "./chat-live-events.ts";
import { retirePullRequestRefreshes } from "./chat-pull-request-refresh.ts";
import { clearPendingQueueItemsForRun } from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { flushChatQueueForEvent, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { applyChatModelCatalogSnapshot } from "./chat-state-refresh.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { retireSessionWorkspaceCheckout } from "./components/chat-session-workspace.ts";
import {
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  retireChatSubmissionDisplay,
} from "./history-merge.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
  reconcileChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { applySessionApprovalEvent } from "./session-approval-projection.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rememberAuthoritativeTerminal } from "./terminal-message-identity.ts";

const BRANCH_TOPOLOGY_REASONS = new Set(["rewind", "branch-switch", "fork", "reset", "new"]);
const PENDING_INPUT_REASONS = new Set(["send", "agent.run.started", "agent.input.settled"]);
type ChatPanePresentation = () => boolean;

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

function globalSessionEventMatchesChat(
  state: ChatPageHost,
  event: NonNullable<ReturnType<typeof readSessionChangedEvent>>,
): boolean {
  if (!isUiGlobalSessionKey(event.key)) {
    return true;
  }
  const selectedAgentId = isUiGlobalSessionKey(state.sessionKey)
    ? resolveUiSelectedGlobalAgentId(state)
    : resolveUiGlobalAliasAgentId(state, state.sessionKey);
  return selectedAgentId
    ? selectedGlobalEventAgentId(state, event.agentId) === selectedAgentId
    : true;
}

function finishSessionMessageRunReconcile(
  state: ChatPageHost,
  sessionKey: string,
  runId: string | null,
  row: SessionChangedRowResult["row"] | undefined,
  presentation: ChatPanePresentation,
): boolean {
  const cleared = row
    ? reconcileChatRunFromSessionRow(state, row, { publishRunStatus: true })
    : reconcileChatRunFromCurrentSessionRow(state, { publishRunStatus: true });
  const session = row ?? selectedChatSessionRow(state);
  const needsRunObservation = Boolean(
    state.chatRunId && session?.hasActiveRun === false && !isSessionRunStateActive(session),
  );
  if (!cleared && !needsRunObservation) {
    return false;
  }
  if (cleared) {
    clearPendingQueueItemsForRun(state, runId ?? undefined);
  }
  // A different completed run cannot settle local ownership without a fresh read.
  void loadChatHistory(state, {
    deferBranches: !presentation(),
    supersedeInFlight: needsRunObservation,
  })
    .finally(() => {
      if (!areUiSessionKeysEquivalent(state.sessionKey, sessionKey)) {
        return;
      }
      void flushChatQueueForEvent(state);
    })
    .catch(() => undefined);
  return true;
}

function handleSessionMessageEvent(
  state: ChatPageHost,
  payload: unknown,
  presentation: ChatPanePresentation,
  result: SessionChangedRowResult,
) {
  const event = readSessionChangedEvent(payload);
  if (!event || !globalSessionEventMatchesChat(state, event)) {
    return false;
  }
  const matchesChat = visibleSessionMatches(state, event.key, event.agentId ?? undefined);
  const isUserMessage =
    readSessionMessageIdentity(asNullableRecord(payload)?.message)?.role === "user";
  if (matchesChat) {
    invalidateChatBranches(state);
    // A pre-commit snapshot can erase even an admitted live reply when its leaf advances.
    // Fence it before run settlement, while retaining the loader's single queued refresh.
    if (getChatHistoryLoadState(state).phase === "in-flight") {
      refreshChatEventHistory(state, presentation(), true);
    }
    // A previous run can persist its final after the next local run starts.
    // Admit that sequenced row now so the later unsequenced chat.final replay
    // replaces it in place instead of appending below the newer user turn.
    applySessionMessagePayload(state, payload, event.hasActiveRun ?? undefined, {
      kind: "live",
      activeRunId: state.chatRunId,
    });
  }
  if (matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  const runIdBeforeApply = state.chatRunId;
  rememberAuthoritativeTerminal({ event, host: state, matchesChat, payload, runIdBeforeApply });
  if (result.applied) {
    if (
      matchesChat &&
      result.row?.lastRunId &&
      result.row.hasActiveRun === false &&
      !isSessionRunStateActive(result.row)
    ) {
      retirePendingChatLiveEvents(state, result.row.lastRunId);
    }
    reconcileChatRunAfterSessionStatePublication(state);
  }
  if (runIdBeforeApply && matchesChat) {
    const runId = event.clientRunId ?? event.runId ?? runIdBeforeApply;
    state.pendingSessionMessageReloadSessionKey = event.key;
    if (event.hasActiveRun === true) {
      if (isUserMessage) {
        // Promotion changes pending custody even while the next turn is active.
        refreshChatEventHistory(state, presentation(), true);
      }
      return true;
    }
    if (finishSessionMessageRunReconcile(state, event.key, runId, result.row, presentation)) {
      state.pendingSessionMessageReloadSessionKey = null;
      return true;
    }
    void refreshCurrentChatSessionList(state).then(() => {
      if (!state.pendingSessionMessageReloadSessionKey || state.chatRunId !== runIdBeforeApply) {
        return;
      }
      if (
        finishSessionMessageRunReconcile(
          state,
          state.pendingSessionMessageReloadSessionKey,
          runId,
          undefined,
          presentation,
        )
      ) {
        state.pendingSessionMessageReloadSessionKey = null;
      }
    });
    return true;
  }
  if (matchesChat) {
    state.pendingSessionMessageReloadSessionKey = null;
    refreshChatEventHistory(state, presentation());
  }
  return matchesChat;
}

function handleSessionsChangedEvent(
  state: ChatPageHost,
  payload: unknown,
  presentation: ChatPanePresentation,
  result: SessionChangedRowResult,
) {
  const presented = presentation();
  const runIdBeforeApply = state.chatRunId;
  const event = readSessionChangedEvent(payload);
  const matchesChat = Boolean(
    event &&
    globalSessionEventMatchesChat(state, event) &&
    visibleSessionMatches(state, event.key, event.agentId ?? undefined),
  );
  const source = asNullableRecord(payload);
  const resetsSession = source?.reason === "reset" || source?.phase === "reset";
  if (event && (resetsSession || source?.reason === "new")) {
    state.retireSessionCompanion?.(event.key, event.agentId);
  }
  const resetsSelectedSession = matchesChat && resetsSession;
  if (matchesChat && (resetsSession || source?.reason === "new")) {
    const initial = state.chatSubmissions?.readInitial(state.sessionKey, state.client ?? null);
    if (initial) {
      retireChatSubmissionDisplay(state, new Set([initial.pendingRunId]));
    }
  }
  const changesBranchTopology =
    matchesChat && typeof source?.reason === "string" && BRANCH_TOPOLOGY_REASONS.has(source.reason);
  if (resetsSelectedSession || changesBranchTopology) {
    retirePendingChatLiveEvents(state);
    retirePullRequestRefreshes(state);
  }
  if (matchesChat && source?.reason === "project") {
    retireSessionWorkspaceCheckout(state);
  }
  if (resetsSelectedSession) {
    const scope = readChatSessionProjectionScope(state, { agentId: resolveChatAgentId(state) });
    // Reset keeps the public session ID; the explicit reducer event is the
    // only proof that its old live and pending transcript no longer exists.
    reduceChatSessionProjection(state, { type: "sessionReset" }, { scope });
  }
  if (changesBranchTopology) {
    invalidateChatBranches(state);
    state.chatBranches = [];
    state.chatBranchesSessionKey = null;
    state.chatBranchesConnectionEpoch = null;
    retireSessionWorkspaceCheckout(state);
    if (presented) {
      void loadChatBranches(state);
    }
  }
  if (event && matchesChat && event.archived !== null) {
    state.selectedChatSessionArchived = event.archived;
  }
  if (result.applied) {
    if (
      matchesChat &&
      result.row?.lastRunId &&
      result.row.hasActiveRun === false &&
      !isSessionRunStateActive(result.row)
    ) {
      retirePendingChatLiveEvents(state, result.row.lastRunId);
    }
    reconcileChatRunAfterSessionStatePublication(state);
  }
  if (resetsSelectedSession || changesBranchTopology) {
    // The old snapshot can already be waiting for live-event code with no cursor.
    refreshChatEventHistory(state, presented, true);
  }
  if (resetsSelectedSession) {
    return true;
  }
  if (matchesChat && source?.reason === "compact") {
    refreshChatEventHistory(state, presented);
    return true;
  }
  if (
    matchesChat &&
    source?.phase === "message" &&
    source.message === undefined &&
    source.messageId === undefined &&
    source.messageSeq === undefined
  ) {
    invalidateChatBranches(state);
    // Legacy multi-message writes cannot prove individual message cursors.
    // A snapshot begun before this invalidation cannot recover the committed rows.
    refreshChatEventHistory(state, presented, true);
    return true;
  }
  if (
    matchesChat &&
    typeof source?.reason === "string" &&
    PENDING_INPUT_REASONS.has(source.reason)
  ) {
    // Custody can change without a transcript append. A read begun before this
    // event must not hide accepted input until the active run ends.
    refreshChatEventHistory(state, presented, true);
  }
  // The session capability owns roster invalidation, including unapplied events.
  // A pane refresh here bypasses its debounce and multiplies reads across split panes.
  if (result.applied && event && runIdBeforeApply && matchesChat) {
    finishSessionMessageRunReconcile(
      state,
      event.key,
      event.clientRunId ?? event.runId ?? runIdBeforeApply,
      result.row,
      presentation,
    );
  }
  return matchesChat;
}

export function handlePageGatewayEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: ChatPanePresentation = () => true,
  sessionResult: SessionChangedRowResult = { applied: false },
): void {
  if (isChatLiveEvent(event)) {
    dispatchChatLiveEvent(state, event, isPresented);
    return;
  }
  handlePageStateEvent(state, event, isPresented, sessionResult);
}

function handlePageStateEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: ChatPanePresentation = () => true,
  sessionResult: SessionChangedRowResult = { applied: false },
): void {
  chatRunPresentation(state).batch(
    () => applyPageStateEvent(state, event, isPresented, sessionResult),
    event.event === "session.message" || event.event === "sessions.changed"
      ? "animation-frame"
      : "immediate",
  );
}

function applyPageStateEvent(
  state: ChatPageHost,
  event: GatewayEventFrame,
  isPresented: ChatPanePresentation,
  sessionResult: SessionChangedRowResult,
): void {
  if (event.event === "models.snapshot") {
    applyChatModelCatalogSnapshot(state);
    return;
  }
  if (event.event === "session.approval") {
    if (applySessionApprovalEvent(state, event.payload, resolveChatAgentId(state))) {
      chatRunPresentation(state).publish();
    }
    return;
  }
  if (event.event === "session.message" || event.event === "sessions.changed") {
    const handle =
      event.event === "session.message" ? handleSessionMessageEvent : handleSessionsChangedEvent;
    const scopedChange = handle(state, event.payload, isPresented, sessionResult);
    void resumeStoredChatOutboxes(state, event);
    if (scopedChange) {
      chatRunPresentation(state).publish("animation-frame");
    }
  }
}
