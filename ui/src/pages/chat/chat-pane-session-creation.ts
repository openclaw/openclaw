import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsRecoverParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { pathForPluginSettings } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/session-create-params.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { pluginDetailLocation } from "../plugins/detail-tabs.ts";
import { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { isExpiredIncognitoSession, setChatError } from "./chat-history-state.ts";
import { createChatModelSetupBanner } from "./chat-model-setup.ts";
import { resolveChatPaneParentSession } from "./chat-pane-header-identity.ts";
import { ChatPaneRetainedPresentation } from "./chat-pane-retained-presentation.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { canCreateChatSession, selectedChatSessionRow } from "./chat-state-route.ts";

/** Creates or resets a conversation while guarding its asynchronous ownership. */
export abstract class ChatPaneSessionCreation extends ChatPaneRetainedPresentation {
  readonly sessionCreation: {
    recovering: boolean;
    creatingIncognito: boolean;
    restartFallback: {
      key: string;
      sessionId: string;
      recoveryCycleId: string;
      generation: number;
    } | null;
  } = { recovering: false, creatingIncognito: false, restartFallback: null };

  protected catalogComposerReason(catalogKey: CatalogSessionKey | null) {
    const { catalogHost, catalogLoading, catalogSession } = this.history;
    // Avoid flashing view-only while metadata loads; failed lookups still explain the gate.
    if (!catalogKey || catalogLoading || catalogSession?.canContinue === true) {
      return null;
    }
    if (catalogHost?.kind === "node") {
      return { text: t("chat.catalog.remoteViewOnly") };
    }
    // Archivable local Codex rows withhold continuation only when supervision is off.
    if (catalogKey.catalogId !== "codex" || catalogSession?.canArchive !== true) {
      return { text: t("chat.catalog.unsupportedViewOnly") };
    }
    const location = pluginDetailLocation(
      { pathname: pathForPluginSettings("codex", this.context.basePath), search: "" },
      true,
    );
    return {
      text: t("chat.codexSupervisionDisabled"),
      action: {
        label: t("chat.openCodexSettings"),
        href: `${location.pathname}${location.search}`,
        onNavigate: () => this.context.navigate("plugin-settings", location),
      },
    };
  }

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
        busy: this.sessionCreation.creatingIncognito,
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
      this.sessionCreation.restartFallback?.key === state.sessionKey &&
      this.sessionCreation.restartFallback.sessionId === session?.sessionId &&
      this.sessionCreation.restartFallback.recoveryCycleId === session?.restartRecoveryCycleId &&
      this.sessionCreation.restartFallback.generation === this.connectionGeneration;
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
      busy: this.sessionCreation.recovering,
      busyLabel: t("chat.resumingSession"),
      disabledReason: access.allowed || this.sessionCreation.recovering ? undefined : access.reason,
      onAction: () => {
        if (access.allowed && !this.sessionCreation.recovering) {
          void this.recoverSession(params);
        }
      },
    };
  }

  protected readonly recoverSession = async (
    identity?: Pick<SessionsRecoverParams, "mode" | "sessionId" | "recoveryCycleId">,
  ): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected || this.sessionCreation.recovering) {
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

    this.sessionCreation.recovering = true;
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
          this.sessionCreation.restartFallback = {
            key: sourceSessionKey,
            sessionId: params.sessionId,
            recoveryCycleId: params.recoveryCycleId,
            generation: this.connectionGeneration,
          };
        }
        setChatError(state, formatUiError(recovery.continuation.error.message));
        return false;
      }
      this.sessionCreation.restartFallback = null;
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
      this.sessionCreation.recovering = false;
    }
  };

  protected readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected || this.sessionCreation.creatingIncognito) {
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
    this.sessionCreation.creatingIncognito = expiredIncognito;
    const signal = this.headerSessionMutationAbortController.signal;
    try {
      const nextSessionKey = await sessions.create(createParams, {
        signal,
      });
      if (signal.aborted || !isCurrent()) {
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
      this.sessionCreation.creatingIncognito = false;
    }
  };
}
