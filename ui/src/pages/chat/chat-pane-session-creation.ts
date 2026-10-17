import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsRecoverParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/create.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { isExpiredIncognitoSession, setChatError } from "./chat-history-state.ts";
import { createChatModelSetupBanner } from "./chat-model-setup.ts";
import { ChatPaneRetainedPresentation } from "./chat-pane-retained-presentation.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { canCreateChatSession, selectedChatSessionRow } from "./chat-state-route.ts";
import { resolveChatPaneParentSession } from "./components/chat-pane-header.ts";

/** Creates or resets a conversation while guarding its asynchronous ownership. */
export abstract class ChatPaneSessionCreation extends ChatPaneRetainedPresentation {
  protected recoveringSession = false;
  protected creatingIncognitoSession = false;
  private restartRecoveryFallback: {
    key: string;
    sessionId: string;
    recoveryCycleId: string;
    generation: number;
  } | null = null;

  protected sessionDisabledBanner(params: {
    catalogDisabledReason: string | null | undefined;
    modelSetupRequired: boolean;
    restartRecoveryTombstoned: boolean;
    selectedSessionArchived: boolean;
    selectedSessionId: string | undefined;
    selectedSession: GatewaySessionRow | undefined;
    sessionKey: string;
    unarchiveAccess: SessionMethodAccess;
  }) {
    if (
      params.selectedSession?.classification === "subagent" ||
      isSubagentSessionKey(params.sessionKey)
    ) {
      const parentKey = resolveUiSessionNavigationParentKey(params.selectedSession);
      const parent = resolveChatPaneParentSession(
        params.selectedSession,
        this.state?.sessionsResult?.sessions ?? [],
      );
      return {
        kind: "composer-replacement" as const,
        presentation: this.onBackToSubagents ? ("hidden" as const) : ("compact" as const),
        icon: "eye" as const,
        title: t("chat.subagentViewOnly"),
        text: t("chat.subagentSessionDisabled", {
          parent: parent?.title ?? t("chat.parentSession"),
        }),
        tone: "neutral" as const,
        actionLabel: t("chat.openParentSession"),
        disabledReason: parentKey ? undefined : t("chat.parentSessionUnavailable"),
        onAction: () => parentKey && this.onPaneSessionChange?.(this.paneId, parentKey),
      };
    }
    if (params.catalogDisabledReason) {
      return undefined;
    }
    if (this.state && isExpiredIncognitoSession(this.state)) {
      const access = readSessionMethodAccess(this.context.gateway.snapshot, {
        method: "sessions.create",
        params: {
          incognito: true,
          agentId:
            scopedAgentParamsForSession(this.state, this.state.sessionKey).agentId ??
            resolveAgentIdFromSessionKey(this.state.sessionKey),
        },
      });
      return {
        kind: "composer-replacement" as const,
        title: t("chat.incognitoExpiredTitle"),
        text: t("chat.incognitoExpiredBody"),
        tone: "neutral" as const,
        actionLabel: t("chat.newIncognitoSession"),
        busy: this.creatingIncognitoSession,
        disabledReason: access.allowed ? undefined : access.reason,
        onAction: () => {
          void this.createSession();
        },
      };
    }
    if (params.restartRecoveryTombstoned) {
      return this.restartRecoveryComposerBanner();
    }
    if (params.selectedSessionArchived) {
      return {
        kind: "composer-replacement" as const,
        text: t("chat.archivedSessionDisabled"),
        icon: "archive" as const,
        actionLabel: t("common.unarchive"),
        disabledReason: !params.selectedSessionId
          ? "Session lifecycle action requires a durable session identity."
          : params.unarchiveAccess.allowed
            ? undefined
            : params.unarchiveAccess.reason,
        onAction: () => {
          if (params.selectedSessionId && params.unarchiveAccess.allowed) {
            void this.restoreArchivedSession(params.sessionKey, params.selectedSessionId);
          }
        },
      };
    }
    return params.modelSetupRequired
      ? createChatModelSetupBanner(() =>
          this.context.navigate("model-providers", { search: "?connect=1" }),
        )
      : undefined;
  }

  protected restartRecoveryComposerBanner() {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const agentId =
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveAgentIdFromSessionKey(state.sessionKey);
    const session = selectedChatSessionRow(state);
    const fallback =
      this.restartRecoveryFallback?.key === state.sessionKey &&
      this.restartRecoveryFallback.sessionId === session?.sessionId &&
      this.restartRecoveryFallback.recoveryCycleId === session?.restartRecoveryCycleId &&
      this.restartRecoveryFallback.generation === this.connectionGeneration;
    const params = {
      ...(agentId ? { agentId } : {}),
      key: state.sessionKey,
      mode: fallback ? ("new-session" as const) : ("in-place" as const),
      sessionId: session?.sessionId,
      recoveryCycleId: session?.restartRecoveryCycleId,
    };
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.recover",
      params,
    });
    return {
      kind: "composer-replacement" as const,
      title: t("chat.restartRecoveryTitle"),
      text: t(fallback ? "chat.restartRecoveryNewSession" : "chat.restartRecoveryDisabled"),
      tone: "neutral" as const,
      icon: "warning" as const,
      actionLabel: t(fallback ? "chat.resumeInNewSession" : "chat.resumeSession"),
      actionStyle: "primary" as const,
      busy: this.recoveringSession,
      busyLabel: t("chat.resumingSession"),
      disabledReason: access.allowed || this.recoveringSession ? undefined : access.reason,
      onAction: () => {
        if (access.allowed && !this.recoveringSession) {
          void this.recoverSession(params);
        }
      },
    };
  }

  protected readonly recoverSession = async (
    identity?: Pick<SessionsRecoverParams, "mode" | "sessionId" | "recoveryCycleId">,
  ): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected || this.recoveringSession) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const scope = { context, state, client, generation: this.connectionGeneration };
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) && this.context.sessions === sessions;
    const sourceSessionKey = state.sessionKey;
    const agentId =
      scopedAgentParamsForSession(state, sourceSessionKey).agentId ??
      resolveAgentIdFromSessionKey(sourceSessionKey);
    const session = selectedChatSessionRow(state);
    const params = {
      ...(agentId ? { agentId } : {}),
      key: sourceSessionKey,
      mode: identity?.mode ?? ("in-place" as const),
      sessionId: identity ? identity.sessionId : session?.sessionId,
      recoveryCycleId: identity ? identity.recoveryCycleId : session?.restartRecoveryCycleId,
    };
    const access = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.recover",
      params,
    });
    if (!access.allowed) {
      setChatError(state, access.reason);
      return false;
    }

    this.recoveringSession = true;
    this.invalidate();
    setChatError(state, null);
    try {
      const recovery = await sessions.recover(params);
      if (!isCurrent() || state.sessionKey !== sourceSessionKey) {
        return false;
      }
      if (!recovery) {
        setChatError(state, state.sessionsError ?? NEW_SESSION_CREATE_FAILED_MESSAGE);
        return false;
      }
      if (recovery.continuation.status === "rejected") {
        if (
          params.mode === "in-place" &&
          params.sessionId &&
          params.recoveryCycleId &&
          recovery.key === sourceSessionKey &&
          recovery.sessionId === params.sessionId &&
          isRecord(recovery.continuation.error.details) &&
          recovery.continuation.error.details.reason === "restart-safe-tools-unavailable"
        ) {
          this.restartRecoveryFallback = {
            key: sourceSessionKey,
            sessionId: params.sessionId,
            recoveryCycleId: params.recoveryCycleId,
            generation: this.connectionGeneration,
          };
        }
        setChatError(state, formatUiError(recovery.continuation.error.message));
        return false;
      }
      this.restartRecoveryFallback = null;
      const nextSessionKey = recovery.key;
      if (areUiSessionKeysEquivalent(nextSessionKey, sourceSessionKey)) {
        return true;
      }
      if (this.onPaneSessionChange?.(this.paneId, nextSessionKey) === false) {
        return false;
      }
      preparePaneSessionHandoff(this.context, this.paneId, nextSessionKey, {
        attachments: [],
        draft: "",
      });
      return true;
    } finally {
      this.recoveringSession = false;
      this.invalidate();
    }
  };

  protected readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected || this.creatingIncognitoSession) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const previousSessionKey = state.sessionKey;
    const expiredIncognito = isExpiredIncognitoSession(state);
    const preservesBoard = !expiredIncognito && this.resolveBoardView().hasBoard;
    const createParams = {
      ...(expiredIncognito
        ? { incognito: true as const }
        : { currentSessionKey: previousSessionKey }),
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    };
    const createRequestParams = {
      ...resolveSessionCreateParams(
        expiredIncognito ? undefined : previousSessionKey,
        createParams.agentId,
      ),
      ...(expiredIncognito ? { incognito: true } : {}),
    };
    const readCreateAccess = () =>
      readSessionMethodAccess(context.gateway.snapshot, {
        method: preservesBoard ? "sessions.reset" : "sessions.create",
        ...(preservesBoard
          ? { requiredScope: "operator.admin" as const }
          : { params: createRequestParams, sessionScope: true }),
      });
    const scope = { context, state, client, generation: this.connectionGeneration };
    const isCurrent = () =>
      this.isConnectionScopeCurrent(scope) && this.context.sessions === sessions;
    if (!canCreateChatSession(state)) {
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      return false;
    }
    if (state.sessionsLoading) {
      setChatError(state, NEW_SESSION_LIST_LOADING_MESSAGE);
      return false;
    }
    const initialAccess = readCreateAccess();
    if (!initialAccess.allowed) {
      setChatError(state, initialAccess.reason);
      return false;
    }
    if (
      (!expiredIncognito && !(await this.confirmConversationReset())) ||
      !isCurrent() ||
      !areUiSessionKeysEquivalent(state.sessionKey, previousSessionKey)
    ) {
      return false;
    }
    if (!canCreateChatSession(state)) {
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      return false;
    }
    const currentAccess = readCreateAccess();
    if (!currentAccess.allowed) {
      setChatError(state, currentAccess.reason);
      return false;
    }

    setChatError(state, null);
    if (preservesBoard) {
      const resetResult = await clearChatHistory(state);
      return resetResult !== "failed";
    }
    this.creatingIncognitoSession = expiredIncognito;
    if (expiredIncognito) {
      this.invalidate();
    }
    try {
      const nextSessionKey = await sessions.create(createParams);
      if (!isCurrent()) {
        return false;
      }
      if (
        !nextSessionKey ||
        state.sessionKey !== previousSessionKey ||
        !canCreateChatSession(state)
      ) {
        if (!nextSessionKey) {
          setChatError(
            state,
            state.sessionsError ??
              (state.sessionsLoading
                ? NEW_SESSION_LIST_LOADING_MESSAGE
                : NEW_SESSION_CREATE_FAILED_MESSAGE),
          );
        }
        return false;
      }
      if (this.onPaneSessionChange?.(this.paneId, nextSessionKey) === false) {
        return false;
      }
      preparePaneSessionHandoff(this.context, this.paneId, nextSessionKey, {
        attachments: cloneChatAttachmentsForIndependentOwner(state.chatAttachments),
        draft: state.chatMessage,
        ...(state.chatMentions?.length
          ? { mentions: state.chatMentions.map((mention) => ({ ...mention })) }
          : {}),
        ...(state.chatGoalDraftMode ? { goalMode: state.chatGoalDraftMode } : {}),
        ...(state.chatReplyTarget ? { replyTarget: state.chatReplyTarget } : {}),
      });
      return true;
    } finally {
      this.creatingIncognitoSession = false;
      if (expiredIncognito && isCurrent()) {
        this.invalidate();
      }
    }
  };
}
