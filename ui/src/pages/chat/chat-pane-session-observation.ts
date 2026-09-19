import type { GatewaySessionRow } from "../../api/types.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { projectSessionResultRows, reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import { chatScopedEventSessionMatches } from "./chat-history-state.ts";
import { ChatPaneSessionCreation } from "./chat-pane-session-creation.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";

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
  if (result === state.sessionsResult && state.sessionsResultAgentId === selectedAgentId) {
    return false;
  }
  state.sessionsResult = result;
  state.sessionsResultAgentId = selectedAgentId;
  return true;
}

export abstract class ChatPaneSessionObservation extends ChatPaneSessionCreation {
  private sessionObservation: {
    matchesPane: () => boolean;
    observation: SessionRowObservation | null;
  } | null = null;

  protected retireSessionObservation() {
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
      return;
    }
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
    const ownsPane = () =>
      this.sessionObservation === binding && state.connected && binding.matchesPane();
    this.sessionObservation = binding;
    binding.observation = sessions.observeRow(
      { key, agentId },
      (row) => {
        if (
          ownsPane() &&
          (row !== null || binding.observation?.hasObserved) &&
          applyObservedChatSessionRow(state, row, binding.observation?.sessionId)
        ) {
          this.requestUpdate();
        }
      },
      {
        onEvent: (event, result) => {
          if (!ownsPane()) {
            return;
          }
          if (binding.observation && !binding.observation.isCurrent()) {
            this.synchronizeSessionObservation();
          }
          if (!ownsPane()) {
            return;
          }
          if (event.event === "session.message") {
            this.clearTypingActorForSessionMessage(event.payload);
          }
          handlePageGatewayEvent(state, event, () => this.presented, result);
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
    }
  }

  protected override setPaneSessionKey(sessionKey: string): string | null {
    const key = super.setPaneSessionKey(sessionKey);
    this.synchronizeSessionObservation();
    return key;
  }
}
