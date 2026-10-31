import type { GatewaySessionRow } from "../../api/types.ts";
import { pathForPluginSettings } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/session-create-params.ts";
import {
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { pluginDetailLocation } from "../plugins/detail-tabs.ts";
import { isExpiredIncognitoSession, setChatError } from "./chat-history-state.ts";
import { createChatModelSetupBanner } from "./chat-model-setup.ts";
import { resolveChatPaneParentSession } from "./chat-pane-header-identity.ts";
import { ChatPaneRetainedPresentation } from "./chat-pane-retained-presentation.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
} from "./chat-pane-shared.ts";
import { canCreateChatSession } from "./chat-state-route.ts";

/** Creates or resets a conversation while guarding its asynchronous ownership. */
export abstract class ChatPaneSessionCreation extends ChatPaneRetainedPresentation {
  readonly sessionCreation = { creatingIncognito: false };

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
    selectedSessionArchived: boolean;
    selectedSessionId: string | undefined;
    selectedSession: GatewaySessionRow | undefined;
    sessionKey: string;
    unarchiveAccess: SessionMethodAccess;
    cached?: boolean;
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
    if (params.selectedSessionArchived) {
      return {
        kind: "composer-replacement" as const,
        text: t("chat.archivedSessionDisabled"),
        icon: "archive" as const,
        actionLabel: t("common.unarchive"),
        actionPending: params.cached,
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
    this.sessionCreation.creatingIncognito = expiredIncognito;
    const signal = this.headerSessionMutationAbortController.signal;
    try {
      const { createCapturedChatSession } =
        await import("./chat-pane-session-operations.runtime.ts");
      return await createCapturedChatSession({
        state,
        context,
        sessions,
        previousSessionKey,
        expiredIncognito,
        preservesBoard,
        createParams,
        readCreateAccess,
        signal,
        isCurrent,
        paneId: this.paneId,
        confirmReset: () => this.confirmConversationReset(),
        onSessionChange: (key) => this.onPaneSessionChange?.(this.paneId, key),
      });
    } catch (error) {
      if (isCurrent() && state.sessionKey === previousSessionKey) {
        setChatError(state, formatUiError(error));
      }
      return false;
    } finally {
      this.sessionCreation.creatingIncognito = false;
    }
  };
}
