import type {
  MessageReactionSummary,
  SessionReactionEvent,
  SessionReactionsListResult,
  SessionReactionsSetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { canReactToSession } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { ChatPaneSharingActions } from "./chat-pane-sharing-actions.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

export abstract class ChatPaneReactions extends ChatPaneSharingActions {
  protected messageReactions = new Map<string, MessageReactionSummary[]>();
  private reactionTarget = "";
  private reactionGeneration = 0;
  private reactionReadUpdates: Map<string, MessageReactionSummary[]> | undefined;
  private readonly reactionRevisions = new Map<string, number>();
  private readonly reactionWrites = new Map<string, symbol>();

  protected resetSessionReactions(): void {
    this.reactionGeneration += 1;
    this.reactionTarget = "";
    this.messageReactions = new Map();
    this.reactionReadUpdates = undefined;
    this.reactionRevisions.clear();
    this.reactionWrites.clear();
  }

  protected canReactToCurrentSession(): boolean {
    const state = this.state;
    return Boolean(
      state &&
      canReactToSession(this.context.gateway.snapshot, selectedChatSessionRow(state), {
        archived: this.isCurrentSessionArchived(state),
        catalog: Boolean(parseCatalogSessionKey(state.sessionKey)),
      }),
    );
  }

  /** Transcript props for reaction chips and pickers. */
  protected reactionChatProps() {
    return {
      messageReactions: this.messageReactions,
      onReact: this.canReactToCurrentSession() ? this.handleMessageReaction : undefined,
    };
  }

  protected syncSessionReactions(): void {
    const scope = this.captureConnectionScope();
    const state = scope?.state;
    const sessionId = state && (selectedChatSessionRow(state)?.sessionId ?? state.currentSessionId);
    const available =
      scope &&
      state &&
      sessionId &&
      !parseCatalogSessionKey(state.sessionKey) &&
      isGatewayMethodAdvertised(scope.context.gateway.snapshot, "session.reactions.list");
    const target = available
      ? JSON.stringify([scope.generation, state.assistantAgentId, state.sessionKey, sessionId])
      : "";
    if (this.reactionTarget === target) {
      return;
    }
    this.resetSessionReactions();
    this.reactionTarget = target;
    if (!available) {
      return;
    }
    const generation = this.reactionGeneration;
    const sessionKey = state.sessionKey;
    const updates = new Map<string, MessageReactionSummary[]>();
    this.reactionReadUpdates = updates;
    const isCurrent = () =>
      generation === this.reactionGeneration &&
      this.isConnectionScopeCurrent(scope) &&
      state.sessionKey === sessionKey &&
      (selectedChatSessionRow(state)?.sessionId ?? state.currentSessionId) === sessionId;
    void scope.client
      .request<SessionReactionsListResult>("session.reactions.list", {
        sessionKey,
        ...scopedAgentParamsForSession(state, sessionKey),
      })
      .then((result) => {
        if (!isCurrent() || result.sessionId !== sessionId) {
          return;
        }
        // Events committed after the list began outrank its older snapshot.
        this.messageReactions = new Map([...Object.entries(result.reactions), ...updates]);
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          state.chatError = formatUiError(error);
        }
      })
      .finally(() => {
        if (generation === this.reactionGeneration) {
          this.reactionReadUpdates = undefined;
          this.requestUpdate();
        }
      });
  }

  protected handleSessionReactionEvent(event: SessionReactionEvent): void {
    const state = this.state;
    if (
      !state?.connected ||
      !uiSessionEventMatches(
        {
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
          sessionKey: state.sessionKey,
        },
        event.sessionKey,
        event.agentId,
      ) ||
      event.sessionId !== (selectedChatSessionRow(state)?.sessionId ?? state.currentSessionId)
    ) {
      return;
    }
    this.syncSessionReactions();
    this.reactionRevisions.set(
      event.messageId,
      (this.reactionRevisions.get(event.messageId) ?? 0) + 1,
    );
    this.reactionReadUpdates?.set(event.messageId, event.reactions);
    this.messageReactions = new Map(this.messageReactions).set(event.messageId, event.reactions);
    this.requestUpdate();
  }

  protected readonly handleMessageReaction = (
    messageId: string,
    emoji: string,
    remove: boolean,
  ): void => {
    void this.setMessageReaction(messageId, emoji, remove);
  };

  protected readonly setMessageReaction = async (
    messageId: string,
    emoji: string,
    remove: boolean,
  ): Promise<void> => {
    const scope = this.captureConnectionScope();
    if (!scope || !this.canReactToCurrentSession()) {
      return;
    }
    this.syncSessionReactions();
    const generation = this.reactionGeneration;
    const revision = this.reactionRevisions.get(messageId) ?? 0;
    const sessionKey = scope.state.sessionKey;
    const sessionId =
      selectedChatSessionRow(scope.state)?.sessionId ?? scope.state.currentSessionId;
    const operation = Symbol("reaction");
    this.reactionWrites.set(messageId, operation);
    const isCurrent = () =>
      generation === this.reactionGeneration &&
      this.reactionWrites.get(messageId) === operation &&
      this.isConnectionScopeCurrent(scope) &&
      scope.state.sessionKey === sessionKey &&
      (selectedChatSessionRow(scope.state)?.sessionId ?? scope.state.currentSessionId) ===
        sessionId;
    try {
      const result = await scope.client.request<SessionReactionsSetResult>(
        "session.reactions.set",
        {
          sessionKey,
          messageId,
          emoji,
          remove,
          ...scopedAgentParamsForSession(scope.state, sessionKey),
        },
      );
      if (!isCurrent()) {
        return;
      }
      if ((this.reactionRevisions.get(messageId) ?? 0) === revision) {
        this.messageReactions = new Map(this.messageReactions).set(messageId, result.reactions);
        this.reactionReadUpdates?.set(messageId, result.reactions);
      }
    } catch (error) {
      if (isCurrent()) {
        scope.state.chatError = formatUiError(error);
        scope.state.lastError = scope.state.chatError;
      }
    } finally {
      if (
        generation === this.reactionGeneration &&
        this.reactionWrites.get(messageId) === operation
      ) {
        this.reactionWrites.delete(messageId);
        this.requestUpdate();
      }
    }
  };
}
