import type { GatewaySessionRow } from "../../api/types.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import {
  projectSessionResultRows,
  readSessionChangedEvent,
  reconcileSessionHistory,
} from "../../lib/sessions/reconcile.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiSessionNavigationParentKey,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { chatScopedEventSessionMatches } from "./chat-history-state.ts";
import { ChatPaneActiveResources } from "./chat-pane-active-resources.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { holdProviderReviewQueuedInputs } from "./chat-provider-review.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { replayPendingChatAbort } from "./run-lifecycle.ts";

function applyObservedChatSessionRow(
  state: ChatPageHost,
  row: GatewaySessionRow | null,
  observedSessionId: string | null = null,
) {
  const selectedAgentId = resolveChatAgentId(state);
  if (!row) {
    const result = state.sessionsResult;
    if (!result || state.sessionsResultAgentId !== selectedAgentId) {
      return false;
    }
    const sessions = result.sessions.filter(
      (candidate) =>
        !chatScopedEventSessionMatches(state, candidate.key, candidate.agentId) ||
        (observedSessionId !== null && candidate.sessionId !== observedSessionId),
    );
    if (sessions.length === result.sessions.length) {
      return false;
    }
    state.sessionsResult = { ...result, sessions, count: sessions.length };
    return true;
  }
  if (!chatScopedEventSessionMatches(state, row.key, row.agentId ?? selectedAgentId)) {
    return false;
  }
  const current = state.sessionsResultAgentId === selectedAgentId ? state.sessionsResult : null;
  const existing = row.sessionId
    ? current?.sessions.find(
        (candidate) =>
          candidate.sessionId === row.sessionId &&
          chatScopedEventSessionMatches(state, candidate.key, candidate.agentId),
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
      state.realtimeTalkSession ||
      state.realtimeTalkActive ||
      state.realtimeTalkUseSystemDefault
    ) {
      stopChatRealtimeTalk(state, { preserveConversation: true });
    }
  }
  if (result === state.sessionsResult && state.sessionsResultAgentId === selectedAgentId) {
    return false;
  }
  state.sessionsResult = result;
  state.sessionsResultAgentId = selectedAgentId;
  return true;
}

export abstract class ChatPaneSessionObservation extends ChatPaneSessionCreation {
  protected readonly activeSessionResources = new ChatPaneActiveResources();

  private sessionObservation: {
    matchesPane: () => boolean;
    observation: SessionRowObservation | null;
  } | null = null;

  private parentSessionObservation: {
    retryFailedRead: () => void;
    matchesPane: () => boolean;
    observation: SessionRowObservation | null;
  } | null = null;

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
    let refreshFailed = false;
    const binding: NonNullable<ChatPaneSessionObservation["parentSessionObservation"]> = {
      retryFailedRead: () => {
        if (refreshFailed) {
          refresh();
        }
      },
      matchesPane: () =>
        this.state === state &&
        state.connected &&
        state.client === client &&
        this.resourceSessionObservation() === selected &&
        resolveUiSessionNavigationParentKey(selected.row) === key,
      observation: null,
    };
    const current = () => this.parentSessionObservation === binding && binding.matchesPane();
    let reading: Promise<void> | null = null;
    const refresh = () => {
      if (reading || !current()) {
        return;
      }
      refreshFailed = false;
      reading = (async () => {
        const observation = binding.observation;
        while (current() && observation?.isCurrent()) {
          const reconcile = observation.captureReconcile();
          const { session } = await client.request<{ session?: GatewaySessionRow }>(
            "sessions.describe",
            { key, agentId },
          );
          if (!current()) {
            return;
          }
          if (reconcile(session).status !== "invalidated") {
            return;
          }
        }
      })()
        .catch(() => {
          // A later history/connection publication can recover without a retry loop.
          refreshFailed = true;
        })
        .finally(() => {
          reading = null;
        });
    };
    this.parentSessionObservation = binding;
    binding.observation = sessions.observeRow(
      { key, agentId },
      (_row, notification) => {
        if (!current()) {
          return;
        }
        this.requestUpdate();
        if (
          !notification?.eventPending &&
          binding.observation &&
          !binding.observation.isCurrent()
        ) {
          this.synchronizeParentSessionObservation();
        }
      },
      {
        onInvalidate: refresh,
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
      refresh();
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

  protected synchronizeSessionObservation() {
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
      this.synchronizeParentSessionObservation();
      return;
    }
    // Unidentified live content keeps its observed incarnation across metadata rebinding.
    const retainedTranscriptSessionId =
      state.chatRunId ||
      state.chatStream != null ||
      getChatSessionProjection(state).entries.some((entry) => !entry.pending)
        ? previous?.observation?.sessionId
        : null;
    this.retireSessionObservation();
    const binding: NonNullable<ChatPaneSessionObservation["sessionObservation"]> = {
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
          if (applyObservedChatSessionRow(state, row, binding.observation?.sessionId)) {
            this.requestUpdate();
          }
          this.synchronizeParentSessionObservation();
          if (state.pendingAbort) {
            void replayPendingChatAbort(state).finally(() => state.requestUpdate?.());
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
              this.requestUpdate();
              return;
            }
            this.activeSessionResources.reconcileObservation({
              requestUpdate: () => this.requestUpdate(),
              updated: () => this.updateComplete,
            });
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
            this.synchronizeSessionObservation();
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
              !chatScopedEventSessionMatches(state, incoming.key, incoming.agentId ?? undefined)
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
            chatScopedEventSessionMatches(state, incoming.key, incoming.agentId ?? undefined) &&
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
    }
  }

  protected projectObservedSessionRow() {
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
      applyObservedChatSessionRow(state, binding.observation.row, binding.observation.sessionId);
      this.synchronizeParentSessionObservation();
    }
  }

  protected override setPaneSessionKey(sessionKey: string): string | null {
    const key = super.setPaneSessionKey(sessionKey);
    this.synchronizeSessionObservation();
    return key;
  }
}
