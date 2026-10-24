import type {
  MessageReactionSummary,
  SessionReactionEvent,
  SessionReactionsListResult,
  SessionReactionsSetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { canReactToSession } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { ChatPaneSharingActions } from "./chat-pane-sharing-actions.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

type PendingReaction = {
  messageId: string;
  emoji: string;
  remove: boolean;
  identity: MessageReactionSummary["identities"][number];
};

export abstract class ChatPaneReactions extends ChatPaneSharingActions {
  private reactionTarget = "";
  private reactionOwner: ReturnType<typeof gatewayPresentationScope> | undefined;
  private reactionReadGeneration = -1;
  private reactionGeneration = 0;
  private reactionReadUpdates: Map<string, MessageReactionSummary[]> | undefined;
  private reactionServer = new Map<string, MessageReactionSummary[]>();
  private readonly reactionPending = new Map<string, PendingReaction>();
  private readonly reactionRevisions = new Map<string, number>();
  private readonly reactionWrites = new Map<string, symbol>();

  protected resetSessionReactions(): void {
    this.reactionGeneration += 1;
    this.reactionTarget = "";
    this.reactionOwner = undefined;
    this.reactionReadGeneration = -1;
    this.collaboration.reactions = new Map();
    this.reactionServer = new Map();
    this.reactionPending.clear();
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

  protected syncSessionReactions(): void {
    const scope = this.captureConnectionScope();
    const state = this.state;
    const sessionId = state && (selectedChatSessionRow(state)?.sessionId ?? state.currentSessionId);
    const available =
      state &&
      sessionId &&
      !parseCatalogSessionKey(state.sessionKey) &&
      (!scope ||
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.reactions.list"));
    const target = available
      ? JSON.stringify([state.assistantAgentId, state.sessionKey, sessionId])
      : "";
    const owner = gatewayPresentationScope(this.context.gateway);
    if (this.reactionTarget !== target || this.reactionOwner !== owner) {
      this.resetSessionReactions();
      this.reactionTarget = target;
      this.reactionOwner = owner;
    }
    if (!available || !scope || this.reactionReadGeneration === scope.generation) {
      return;
    }
    this.reactionReadGeneration = scope.generation;
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
        this.reactionServer = new Map([...Object.entries(result.reactions), ...updates]);
        this.publishReactions();
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          state.chatError = formatUiError(error);
        }
      })
      .finally(() => {
        if (this.reactionReadUpdates === updates) {
          this.reactionReadUpdates = undefined;
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
    this.reactionServer.set(event.messageId, event.reactions);
    this.publishReactions();
  }

  private publishReactions(): void {
    const reactions = new Map(this.reactionServer);
    for (const pending of this.reactionPending.values()) {
      const summaries = [...(reactions.get(pending.messageId) ?? [])];
      const index = summaries.findIndex((summary) => summary.emoji === pending.emoji);
      const previous = summaries[index];
      const identities = (previous?.identities ?? []).filter(
        (identity) => identity.id !== pending.identity.id,
      );
      if (!pending.remove) {
        identities.push(pending.identity);
      }
      if (identities.length > 0) {
        const summary = { emoji: pending.emoji, count: identities.length, identities };
        if (index < 0) {
          summaries.push(summary);
        } else {
          summaries[index] = summary;
        }
      } else if (index >= 0) {
        summaries.splice(index, 1);
      }
      reactions.set(pending.messageId, summaries);
    }
    this.collaboration.reactions = reactions;
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
    const state = this.state;
    if (!state || !this.canReactToCurrentSession()) {
      return;
    }
    this.syncSessionReactions();
    const generation = this.reactionGeneration;
    const context = this.context;
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    const deferredOwner =
      !scope || gateway.snapshot.deferredIntentCount || gateway.snapshot.deferredIntentDraining
        ? gatewayPresentationScope(gateway)
        : undefined;
    const sessionKey = state.sessionKey;
    const sessionId = selectedChatSessionRow(state)?.sessionId ?? state.currentSessionId;
    const params = {
      sessionKey,
      messageId,
      emoji,
      remove,
      ...scopedAgentParamsForSession(state, sessionKey),
    };
    const ownsTarget = () =>
      generation === this.reactionGeneration &&
      this.context === context &&
      this.state === state &&
      (deferredOwner
        ? gatewayPresentationScope(gateway) === deferredOwner
        : context.gateway.snapshot.client === client) &&
      state.sessionKey === sessionKey &&
      (selectedChatSessionRow(state)?.sessionId ?? state.currentSessionId) === sessionId;
    const key = `reaction:${sessionKey}:${messageId}:${emoji}`;
    let pending: PendingReaction | undefined;
    const run = async (requestClient: NonNullable<typeof client>) => {
      const publicationScope = deferredOwner ? this.captureConnectionScope() : scope;
      const revision = this.reactionRevisions.get(messageId) ?? 0;
      const operation = Symbol("reaction");
      this.reactionWrites.set(messageId, operation);
      const isCurrent = () =>
        ownsTarget() &&
        this.reactionWrites.get(messageId) === operation &&
        publicationScope !== null &&
        this.isConnectionScopeCurrent(publicationScope);
      try {
        const result = await requestClient.request<SessionReactionsSetResult>(
          "session.reactions.set",
          params,
        );
        if (isCurrent() && (this.reactionRevisions.get(messageId) ?? 0) === revision) {
          this.reactionServer.set(messageId, result.reactions);
          this.reactionReadUpdates?.set(messageId, result.reactions);
        }
      } catch (error) {
        if (isCurrent()) {
          state.chatError = formatUiError(error);
          state.lastError = state.chatError;
        } else if (
          pending &&
          !ownsTarget() &&
          this.context === context &&
          context.gateway === gateway &&
          gateway.snapshot.client === requestClient &&
          !requestClient.offlineRecoveryRetired &&
          gatewayPresentationScope(gateway) === deferredOwner
        ) {
          showToast({ message: formatUiError(error) });
        }
      } finally {
        if (ownsTarget()) {
          if (pending && this.reactionPending.get(key) === pending) {
            this.reactionPending.delete(key);
          }
          if (this.reactionWrites.get(messageId) === operation) {
            this.reactionWrites.delete(messageId);
          }
          this.publishReactions();
        }
      }
    };
    if (!scope || deferredOwner) {
      const self = deferredOwner?.displayUser;
      if (self?.identity?.type !== "profile") {
        return;
      }
      pending = { messageId, emoji, remove, identity: { id: self.identity.id, label: self.name } };
      const discard = () => {
        if (ownsTarget() && this.reactionPending.get(key) === pending) {
          this.reactionPending.delete(key);
          this.publishReactions();
        }
      };
      // Install the replacement before the queue discards its superseded intent.
      this.reactionPending.set(key, pending);
      this.publishReactions();
      if (!context.gateway.defer({ key, run, discard })) {
        discard();
      }
      return;
    }
    await run(scope.client);
  };
}
