import type { ApplicationContext } from "../../app/context.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { cacheChatComposerAgentDefault } from "./chat-composer-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatSnapshotKey } from "./session-message-cache.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

export function subscribeChatPaneSnapshotInvalidation(
  getState: () => ChatPageHost | undefined,
  onInvalidate?: () => void,
): () => void {
  return subscribeSnapshotInvalidation(({ sessionKey, scopePrefix, reason }) => {
    // Cache eviction must preserve the active transcript and its completed load.
    const state = getState();
    if (
      reason === "cache-eviction" ||
      !state ||
      (scopePrefix &&
        !resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }).startsWith(scopePrefix)) ||
      (sessionKey && resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }) !== sessionKey)
    ) {
      return;
    }
    onInvalidate?.();
    resetChatHistoryProjection(state);
  });
}

export function subscribeChatPaneSettings(
  state: ChatPageHost,
  context: Pick<ApplicationContext, "theme" | "gateway">,
): () => void {
  return context.theme.subscribe(() => {
    const previousInlineCommands = state.settings.chatInlineCommands === true;
    // Chat actions read these synchronous owner settings before any render commits.
    state.settings = { ...context.theme.settings, token: context.gateway.connection.token };
    if (
      previousInlineCommands !== (state.settings.chatInlineCommands === true) &&
      !parseCatalogSessionKey(state.sessionKey)
    ) {
      void syncSelectedSessionMessageSubscription(state);
    }
  });
}

export function subscribeChatPaneAgentFacts(
  context: ApplicationContext,
  state: ChatPageHost,
): () => void {
  const stopIdentity = context.agentIdentity.subscribe(() => void state.loadAssistantIdentity());
  const stopDefaults = context.agents.subscribe(() => cacheChatComposerAgentDefault(state));
  return () => {
    stopIdentity();
    stopDefaults();
  };
}
