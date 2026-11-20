import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { subscribeHomeHelp, takeHomeHelpDraft } from "../../app/home-help.ts";
import { patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { focusComposerInput } from "../../lib/composer-input.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { cacheChatComposerAgentDefault } from "./chat-composer-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { inlineCommandPresentation } from "./chat-inline-command-presentation.ts";
import type { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { resolveChatSnapshotKey } from "./session-message-cache.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

registerChatSessionEnglish();

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
  let active = true;
  let loading: Promise<void> | undefined;
  const synchronize = (
    previousInlineCommands = state.settings.chatInlineCommands === true &&
      state.inlineCommandPresentation !== undefined,
  ) => {
    // Chat actions read these synchronous owner settings before any render commits.
    state.settings = { ...context.theme.settings, token: context.gateway.connection.token };
    if (!state.settings.chatInlineCommands || state.inlineCommandPresentation) {
      state.clearInlineCommandError();
    }
    if (state.settings.chatInlineCommands && !state.inlineCommandPresentation) {
      loading ??= state
        .prepareInlineCommands(
          () => active && context.theme.settings.chatInlineCommands === true,
          () => synchronize(false),
        )
        .finally(() => {
          loading = undefined;
        });
    }
    if (
      previousInlineCommands !==
        (state.settings.chatInlineCommands === true &&
          state.inlineCommandPresentation !== undefined) &&
      !parseCatalogSessionKey(state.sessionKey)
    ) {
      void syncSelectedSessionMessageSubscription(state);
    }
  };
  const unsubscribe = context.theme.subscribe(() => synchronize());
  return () => {
    active = false;
    unsubscribe();
  };
}

export function initializeChatPaneSettings(
  state: ChatPageHost,
  page: { inlineCommandPreparationError?: string; isCurrent?: () => boolean },
): void {
  let inlineCommandRequest = 0;
  // Local intent, peer preferences, and startup recovery share this error receipt.
  let clearInlineCommandError =
    page.inlineCommandPreparationError &&
    state.settings.chatInlineCommands &&
    !state.inlineCommandPresentation
      ? state.setRecoverableChatError(
          t("chat.view.inlineCommandsUnavailable"),
          page.inlineCommandPreparationError,
        )
      : undefined;
  state.clearInlineCommandError = () => {
    clearInlineCommandError?.();
    clearInlineCommandError = undefined;
  };
  state.prepareInlineCommands = async (isCurrent, onReady) => {
    try {
      const presentation = await inlineCommandPresentation();
      if (isCurrent()) {
        state.inlineCommandPresentation = presentation;
        onReady();
      }
    } catch (error) {
      if (isCurrent()) {
        state.clearInlineCommandError();
        clearInlineCommandError = state.setRecoverableChatError(
          t("chat.view.inlineCommandsUnavailable"),
          error,
        );
      }
    }
  };
  state.applySettings = (patch) => {
    if (patch.chatInlineCommands !== undefined) {
      inlineCommandRequest++;
    }
    const apply = () => {
      if (patch.chatInlineCommands !== undefined) {
        state.clearInlineCommandError();
      }
      state.settings = patchSettings(patch);
    };
    if (patch.chatInlineCommands && !state.inlineCommandPresentation) {
      const gatewayUrl = state.settings.gatewayUrl;
      const request = inlineCommandRequest;
      const isCurrent = () =>
        request === inlineCommandRequest &&
        state.settings.gatewayUrl === gatewayUrl &&
        (page.isCurrent?.() ?? true);
      void state.prepareInlineCommands(isCurrent, apply);
    } else {
      apply();
    }
  };
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

export function receiveHomeHelpDraft(
  host: Pick<
    ChatPaneStateOwner,
    "context" | "state" | "active" | "presented" | "inputRegion" | "presentationId" | "agentId"
  >,
): void {
  if (
    !host.state ||
    !host.active ||
    !host.presented ||
    chatInputOwnerForContext(host.context).current !== host.inputRegion
  ) {
    return;
  }
  const textarea = getChatComposerState(host.presentationId).composerTextarea;
  if (!textarea) {
    return;
  }
  const draft = takeHomeHelpDraft(
    host.context,
    resolveUiConversationIdentity(host.state, host.state.sessionKey, host.agentId),
  );
  if (draft === undefined) {
    return;
  }
  // Read the live editor, not a delayed projection, and retain attachments,
  // mentions and the existing question. Nothing is submitted by this handoff.
  host.state.handleChatDraftChange([textarea.value, draft].filter(Boolean).join("\n\n"));
  focusComposerInput(textarea, { preventScroll: true });
}

export function subscribeChatPaneHomeHelp(
  host: Parameters<typeof receiveHomeHelpDraft>[0],
): () => void {
  return subscribeHomeHelp(host.context, () => receiveHomeHelpDraft(host));
}
