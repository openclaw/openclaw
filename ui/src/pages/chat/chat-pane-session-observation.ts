import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import {
  projectSessionResultRows,
  readSessionChangedEvent,
  reconcileSessionHistory,
} from "../../lib/sessions/reconcile.ts";
import type {
  SessionCapability,
  SessionRowObservation,
} from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  isUiSelectedGlobalSessionKey,
  resolveUiConfiguredMainKey,
  parseAgentSessionKey,
  resolveUiSessionNavigationParentKey,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { commitCurrentChatHistorySnapshot } from "./chat-history-snapshot.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { applySelectedSessionProjection } from "./chat-pane-state.ts";
import { holdProviderReviewQueuedInputs } from "./chat-provider-review.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { flushChatQueueForEvent, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import {
  reconcileChatRunAfterSessionStatePublication,
  replayPendingChatAbort,
} from "./run-lifecycle.ts";
import { clearChatMessagesFromCache, readChatSessionSnapshot } from "./session-message-cache.ts";

function createSessionObservationRefresh(
  sessions: Pick<SessionCapability, "describe" | "canonicalListRevision">,
  target: { key: string; agentId: string },
  client: GatewayBrowserClient,
  current: () => boolean,
  observation: () => SessionRowObservation | null,
  retryAfterList = false,
) {
  let reading: Promise<void> | null = null;
  let pending = false;
  let failedListRevision: number | undefined;
  const refresh = () => {
    if (!current()) {
      return;
    }
    pending = true;
    const selected = observation();
    if (reading || !selected?.isCurrent()) {
      return;
    }
    pending = false;
    failedListRevision = undefined;
    const reconcile = selected.captureReconcile();
    reading = sessions
      .describe(target, { client })
      .then(({ session }) => {
        if (current()) {
          reconcile(session ?? undefined);
        }
      })
      .catch(() => {
        failedListRevision = sessions.canonicalListRevision;
      })
      .finally(() => {
        reading = null;
        if (pending) {
          refresh();
        }
      });
  };
  return {
    refresh,
    retryFailedRead: () => {
      if (
        failedListRevision !== undefined &&
        (!retryAfterList || sessions.canonicalListRevision > failedListRevision)
      ) {
        refresh();
      }
    },
  };
}

function applyObservedChatSessionRow(
  state: ChatPageHost,
  row: GatewaySessionRow | null,
  observedSessionId: string | null,
  retireSessionMutations: () => void,
): void {
  const selectedAgentId = resolveChatAgentId(state);
  if (!row) {
    const result = state.sessionsResult;
    if (!result || state.sessionsResultAgentId !== selectedAgentId) {
      return;
    }
    const sessions = result.sessions.filter(
      (candidate) =>
        !visibleSessionMatches(state, candidate.key, candidate.agentId) ||
        (observedSessionId !== null && candidate.sessionId !== observedSessionId),
    );
    if (sessions.length === result.sessions.length) {
      return;
    }
    retireSessionMutations();
    state.sessionsResult = { ...result, sessions, count: sessions.length };
    return;
  }
  if (!visibleSessionMatches(state, row.key, row.agentId ?? selectedAgentId)) {
    return;
  }
  const current = state.sessionsResultAgentId === selectedAgentId ? state.sessionsResult : null;
  const existing = row.sessionId
    ? current?.sessions.find(
        (candidate) =>
          candidate.sessionId === row.sessionId &&
          visibleSessionMatches(state, candidate.key, candidate.agentId),
      )
    : undefined;
  const projected =
    existing && existing.key !== row.key
      ? state.sessions.inheritRow({ ...row, key: existing.key }, row)
      : row;
  // The row owner already admitted this incarnation; do not reapply history's clock gate.
  const result =
    current && existing
      ? projectSessionResultRows(
          current,
          current.sessions.map((candidate) => (candidate === existing ? projected : candidate)),
        )
      : reconcileSessionHistory(
          current,
          row,
          undefined,
          {
            resultAgentId: selectedAgentId,
            selectedGlobalAgentId: selectedAgentId,
            archivedFilter: row.archived ? "all" : state.sessionsArchivedFilter,
          },
          false,
          { project: (next, previous) => state.sessions.inheritRow(next, row, previous) },
        );
  if (row.providerReview) {
    holdProviderReviewQueuedInputs(state, row.key, row.agentId ?? selectedAgentId);
    if (
      state.realtimeTalk.snapshot.realtimeTalkSession ||
      state.realtimeTalk.snapshot.realtimeTalkActive ||
      state.realtimeTalk.snapshot.realtimeTalkUseSystemDefault
    ) {
      stopChatRealtimeTalk(state, { preserveConversation: true });
    }
  }
  const previous = current?.sessions.find((candidate) =>
    visibleSessionMatches(state, candidate.key, candidate.agentId),
  );
  if (previous && previous.sessionId !== row.sessionId) {
    // Release pending header presentation before publishing a replacement incarnation.
    retireSessionMutations();
  }
  state.sessionsResult = result;
  state.sessionsResultAgentId = selectedAgentId;
}

export abstract class ChatPaneSessionObservation extends ChatPaneSessionCreation {
  // Capability identity matters because a replacement restarts its canonical revision at zero.
  private canonicalSessionList?: {
    sessions: SessionCapability;
    revision: number;
    outboxState?: string;
  };

  protected transcriptSessionProps(selectedSession: GatewaySessionRow | undefined) {
    const state = this.state;
    if (!state || parseCatalogSessionKey(state.sessionKey)) {
      return { selectedSession: undefined };
    }
    const observation = this.resourceSessionObservation();
    const session = selectedSession ?? observation?.row ?? undefined;
    if (
      !this.ownsChatSnapshot({ sessionKey: state.sessionKey }) ||
      observation?.hasObserved ||
      (session && !state.sessions.state.resultCached)
    ) {
      return { selectedSession: session };
    }
    const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
      sessionKey: state.sessionKey,
    });
    return {
      selectedSession: session,
      transcriptMetadata:
        snapshot?.sessionId === state.currentSessionId ? snapshot?.transcriptMetadata : undefined,
    };
  }

  protected applySessionsState(stateValue: SessionCapability["state"]) {
    const state = this.state;
    if (!state) {
      return;
    }
    const canonicalListRevision = this.context.sessions.canonicalListRevision;
    const previousCanonical = this.canonicalSessionList;
    const canonicalListPublished =
      previousCanonical?.sessions === this.context.sessions &&
      canonicalListRevision > previousCanonical.revision;
    const selectedSessionDeleted = this.context.sessions.deletionState(
      state.sessionKey,
      resolveChatAgentId(state),
    );
    for (const { key, agentId } of stateValue.deletedSessions) {
      clearChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: key, agentId });
    }
    // Live rows retire on disconnect; the session owner retains same-identity
    // presentation (including deferred metadata) until the next canonical list.
    const presentation = this.context.sessions.presentation;
    // A list for another agent must not overwrite this pane's global history.
    if (
      !isUiSelectedGlobalSessionKey(state, state.sessionKey) ||
      presentation.agentId === resolveChatAgentId(state)
    ) {
      state.sessionsResult = presentation.result;
      state.sessionsResultAgentId = presentation.agentId;
    }
    this.projectObservedSessionRow();
    state.sessionsLoading = stateValue.loading;
    state.sessionsError = stateValue.error;
    if (state.connected && state.pendingAbort) {
      void replayPendingChatAbort(state);
    }
    this.refreshSwarmRoster();
    const selectedSession = selectedChatSessionRow(state);
    if (
      (!stateValue.resultCached || this.resourceSessionObservation()?.hasObserved) &&
      selectedSession?.sessionId &&
      selectedSession.sessionId === state.currentSessionId &&
      this.ownsChatSnapshot({ sessionKey: state.sessionKey })
    ) {
      commitCurrentChatHistorySnapshot(state, undefined, selectedSession);
    }
    const outboxState = selectedSession
      ? JSON.stringify([
          state.sessionKey,
          resolveChatAgentId(state),
          selectedSession.sessionId,
          selectedSession.status,
          isSessionRunStateActive(selectedSession),
          selectedSession.lastRunId,
          selectedSession.activeLeafEntryId,
        ])
      : undefined;
    this.canonicalSessionList = {
      sessions: this.context.sessions,
      revision: canonicalListRevision,
      outboxState: canonicalListPublished
        ? outboxState
        : previousCanonical?.sessions === this.context.sessions
          ? previousCanonical.outboxState
          : undefined,
    };
    if (applySelectedSessionProjection(state, selectedSession)) {
      // Hidden retained panes keep this subscription alive; only the pane the
      // user is actually looking at may clear unread/attention state.
      if (this.presented) {
        this.markSessionRead(selectedSession);
      }
    }
    this.syncSessionSuggestionTarget(
      resolveChatAgentId(state) ?? stateValue.agentId ?? "main",
      selectedSession,
    );
    if (selectedSessionDeleted) {
      const agentId = resolveChatAgentId(state);
      this.onSessionDeleted?.(
        this.paneId,
        state.sessionKey,
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: this.context.agents.state.agentsList,
            hello: this.context.gateway.snapshot.hello,
          }),
        }),
        selectedSessionDeleted === "pending",
      );
      return;
    }
    const reconciledLocalCompletion = reconcileChatRunAfterSessionStatePublication(state);
    this.reconcileWaitingApprovalSnapshot();
    if (reconciledLocalCompletion) {
      void resumeStoredChatOutboxes(state);
      return;
    }
    // First canonical idle and changed run/branch identity can release a queue.
    // Re-decoding an unchanged row after foreign activity is not new delivery intent.
    if (
      canonicalListPublished &&
      previousCanonical?.outboxState !== outboxState &&
      selectedSession &&
      !isSessionRunStateActive(selectedSession) &&
      state.chatQueue.length > 0
    ) {
      void flushChatQueueForEvent(state);
    }
  }

  private publishParentRow?: () => void;
  readonly parentSession = {
    read: () => this.observedParentSessionRow(),
    subscribe: (listener: () => void) => {
      this.publishParentRow = listener;
      return () => {
        this.publishParentRow = undefined;
      };
    },
  };

  private sessionObservation: {
    retryFailedRead: () => void;
    matchesPane: () => boolean;
    observation: SessionRowObservation | null;
  } | null = null;

  private parentSessionObservation: {
    retryFailedRead: () => void;
    matchesPane: () => boolean;
    observation: SessionRowObservation | null;
  } | null = null;

  protected resumeConfirmedRouteWork(routeResolutionChanged?: boolean): void {
    const state = this.state;
    if (!routeResolutionChanged || this.routeResolutionPending || !state) {
      return;
    }
    void resumeStoredChatOutboxes(state);
  }

  protected observedParentSessionRow(): GatewaySessionRow | null {
    const binding = this.parentSessionObservation;
    return binding?.matchesPane() && binding.observation?.isCurrent()
      ? binding.observation.row
      : null;
  }

  private retireParentSessionObservation() {
    const previous = this.parentSessionObservation;
    this.parentSessionObservation = null;
    previous?.observation?.dispose();
    if (previous) {
      this.publishParentRow?.();
    }
  }

  private synchronizeParentSessionObservation() {
    const state = this.state;
    const selected = this.resourceSessionObservation();
    const key = resolveUiSessionNavigationParentKey(selected?.row);
    if (
      !state?.connected ||
      !selected ||
      !key ||
      areUiSessionKeysEquivalent(key, state.sessionKey)
    ) {
      this.retireParentSessionObservation();
      return;
    }
    const previous = this.parentSessionObservation;
    if (previous?.matchesPane() && previous.observation?.isCurrent()) {
      previous.retryFailedRead();
      return;
    }
    this.retireParentSessionObservation();
    const sessions = this.context.sessions;
    const client = state.client;
    if (!client) {
      return;
    }
    const agentId = parseAgentSessionKey(key)?.agentId ?? resolveChatAgentId(state);
    const binding: NonNullable<ChatPaneSessionObservation["parentSessionObservation"]> = {
      retryFailedRead: () => refresh.retryFailedRead(),
      matchesPane: () =>
        this.state === state &&
        state.connected &&
        state.client === client &&
        this.resourceSessionObservation() === selected &&
        resolveUiSessionNavigationParentKey(selected.row) === key,
      observation: null,
    };
    const current = () => this.parentSessionObservation === binding && binding.matchesPane();
    const refresh = createSessionObservationRefresh(
      sessions,
      { key, agentId },
      client,
      current,
      () => binding.observation,
      true,
    );
    this.parentSessionObservation = binding;
    binding.observation = sessions.observeRow(
      { key, agentId },
      (_row, notification) => {
        if (!current()) {
          return;
        }
        this.publishParentRow?.();
        if (
          !notification?.eventPending &&
          binding.observation &&
          !binding.observation.isCurrent()
        ) {
          this.synchronizeParentSessionObservation();
        }
      },
      {
        onInvalidate: refresh.refresh,
        onEvent: () => {
          if (current() && !binding.observation?.isCurrent()) {
            this.synchronizeParentSessionObservation();
          }
        },
      },
    );
    if (!current()) {
      binding.observation.dispose();
    } else {
      this.publishParentRow?.();
      refresh.refresh();
    }
  }

  protected resourceSessionObservation(): SessionRowObservation | null {
    const binding = this.sessionObservation;
    return binding?.matchesPane() && binding.observation?.isCurrent() ? binding.observation : null;
  }

  protected retireSessionObservation() {
    this.retireParentSessionObservation();
    const previous = this.sessionObservation;
    this.sessionObservation = null;
    previous?.observation?.dispose();
  }

  protected synchronizeSessionObservation(options: { eventSessionId?: string | null } = {}) {
    const state = this.state;
    const sessions = this.context.sessions;
    if (!state?.connected || !state.sessionKey.trim() || parseCatalogSessionKey(state.sessionKey)) {
      this.retireSessionObservation();
      return;
    }
    const scope = sessions.captureConnectionScope();
    if (!scope) {
      this.retireSessionObservation();
      return;
    }
    const key = state.sessionKey;
    const agentId = resolveChatAgentId(state);
    const previous = this.sessionObservation;
    if (previous?.matchesPane() && previous.observation?.isCurrent()) {
      previous.retryFailedRead();
      this.synchronizeParentSessionObservation();
      return;
    }
    const previousObservationSessionId = previous?.matchesPane()
      ? previous.observation?.sessionId
      : null;
    // Unidentified live content keeps its observed incarnation across metadata rebinding.
    const retainedTranscriptSessionId =
      state.chatRunId ||
      state.chatStream != null ||
      getChatSessionProjection(state).entries.some((entry) => !entry.pending)
        ? previous?.observation?.sessionId
        : null;
    this.retireSessionObservation();
    const binding: NonNullable<ChatPaneSessionObservation["sessionObservation"]> = {
      retryFailedRead: () => refreshRunner.retryFailedRead(),
      matchesPane: () =>
        this.state === state &&
        state.sessionKey === key &&
        resolveChatAgentId(state) === agentId &&
        sessions === this.context.sessions &&
        sessions.isConnectionScopeCurrent(scope),
      observation: null,
    };
    const ownsPaneScope = () => state.connected && binding.matchesPane();
    const ownsPane = () => this.sessionObservation === binding && ownsPaneScope();
    const refreshRunner = createSessionObservationRefresh(
      sessions,
      { key, agentId },
      scope.client,
      ownsPane,
      () => binding.observation,
    );
    this.sessionObservation = binding;
    binding.observation = sessions.observeRow(
      { key, agentId },
      (row, notification) => {
        if (ownsPane() && (row !== null || binding.observation?.hasObserved)) {
          const pending = state.pendingAbort;
          // A resolved absence retires this target; a row still loading keeps its intent.
          if (
            !row &&
            pending &&
            uiConversationMatches(state, pending.sessionKey, key, agentId, pending.agentId)
          ) {
            state.pendingAbort = null;
          }
          applyObservedChatSessionRow(state, row, binding.observation?.sessionId ?? null, () =>
            this.retireHeaderSessionMutations(),
          );
          this.synchronizeParentSessionObservation();
          if (state.pendingAbort) {
            void replayPendingChatAbort(state);
          }
        }
        // Apply the retired row first so deletion cannot survive the replacement binding.
        if (
          !notification?.eventPending &&
          ownsPane() &&
          binding.observation &&
          !binding.observation.isCurrent()
        ) {
          this.synchronizeSessionObservation();
        }
      },
      {
        onInvalidate: (reason) => {
          if (ownsPane()) {
            if (reason === "runner-availability") {
              this.activeSessionResources.invalidate();
              refreshRunner.refresh();
              return;
            }
            this.activeSessionResources.reconcileObservation();
          }
        },
        onEvent: (event, result) => {
          if (!ownsPane()) {
            return;
          }
          if (result.generationRejected) {
            this.synchronizeSessionObservation();
            if (ownsPaneScope()) {
              void resumeStoredChatOutboxes(state, event);
            }
            return;
          }
          let eventResult = result;
          let predecessorSessionId = retainedTranscriptSessionId;
          const incoming = readSessionChangedEvent(event.payload);
          if (binding.observation && !binding.observation.isCurrent()) {
            const previousSessionId = binding.observation.sessionId;
            predecessorSessionId = previousSessionId;
            this.synchronizeSessionObservation({ eventSessionId: incoming?.sessionId });
            const replacement = this.sessionObservation;
            if (
              !ownsPaneScope() ||
              !replacement?.matchesPane() ||
              !replacement.observation?.isCurrent()
            ) {
              return;
            }
            if (
              !incoming?.sessionId ||
              incoming.sessionId === previousSessionId ||
              incoming.sessionId !== replacement.observation.sessionId ||
              incoming.sessionId !== replacement.observation.row?.sessionId ||
              !visibleSessionMatches(state, incoming.key, incoming.agentId ?? undefined)
            ) {
              void resumeStoredChatOutboxes(state, event);
              return;
            }
            // The captured recipient can finish its frame; its retired row receipt cannot transfer.
            eventResult = { applied: false };
          }
          const observation = this.sessionObservation?.observation;
          const transcriptSessionId = state.currentSessionId ?? predecessorSessionId;
          if (
            incoming?.sessionId &&
            observation?.isCurrent() &&
            incoming.sessionId === observation.sessionId &&
            incoming.sessionId === observation.row?.sessionId &&
            visibleSessionMatches(state, incoming.key, incoming.agentId ?? undefined) &&
            transcriptSessionId &&
            transcriptSessionId !== incoming.sessionId &&
            (state.currentSessionId ||
              state.chatRunId ||
              state.chatStream != null ||
              getChatSessionProjection(state).entries.some((entry) => !entry.pending))
          ) {
            // Row rebinding cannot transfer a predecessor's transcript or live work.
            this.refreshHistory();
            void resumeStoredChatOutboxes(state, event);
            return;
          }
          if (event.event === "session.message") {
            this.clearTypingActorForSessionMessage(event.payload);
          }
          handlePageGatewayEvent(state, event, () => this.presented, eventResult);
        },
      },
    );
    if (!ownsPane()) {
      binding.observation.dispose();
    } else {
      // The owner can publish its first result synchronously before the handle returns.
      this.projectObservedSessionRow();
      const observation = binding.observation;
      const transcriptSessionId = state.currentSessionId ?? retainedTranscriptSessionId;
      if (
        previousObservationSessionId &&
        observation?.isCurrent() &&
        observation.sessionId &&
        observation.sessionId !== options.eventSessionId &&
        observation.sessionId !== previousObservationSessionId &&
        observation.row?.sessionId === observation.sessionId &&
        transcriptSessionId &&
        transcriptSessionId !== observation.sessionId
      ) {
        // A canonical read can admit the successor after its event was fenced.
        this.refreshHistory();
      }
    }
  }

  private projectObservedSessionRow() {
    const state = this.state;
    const binding = this.sessionObservation;
    if (!state || !binding) {
      return;
    }
    if (
      binding.matchesPane() &&
      binding.observation?.hasObserved &&
      binding.observation?.isCurrent()
    ) {
      applyObservedChatSessionRow(
        state,
        binding.observation.row,
        binding.observation.sessionId,
        () => this.retireHeaderSessionMutations(),
      );
      this.synchronizeParentSessionObservation();
    }
  }

  protected override setPaneSessionKey(sessionKey: string): string | null {
    const key = super.setPaneSessionKey(sessionKey);
    this.synchronizeSessionObservation();
    return key;
  }
}
