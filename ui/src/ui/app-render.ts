// Control UI module implements app render behavior.
import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../app-navigation.ts";
import {
  appRouter,
  pathForRoute,
  resolveAppNotFound,
  searchForSession,
  type ApplicationContext,
  type AppRouteModule,
  type RouteId,
} from "../app-routes.ts";
import {
  renderRouterOutlet,
  routerOutlet,
  type RouterOutletSelection,
} from "../app/router-outlet.ts";
import "../components/app-sidebar.ts";
import "../components/app-topbar.ts";
import "../components/command-palette.ts";
import "../components/exec-approval.ts";
import "../components/gateway-url-confirmation.ts";
import "../components/login-gate.ts";
import "../components/page-header.ts";
import "../components/update-banner.ts";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  isSessionKeyTiedToAgent,
  normalizeAgentId,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { resolveAgentIdForSession } from "../pages/chat/chat-avatar.ts";
import { runUpdate } from "../pages/config/data.ts";
import { resolveDashboardHeaderContext } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { renderChatSessionSelect } from "./chat/session-controls.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";

function isSidebarSessionBusy(state: AppViewState) {
  return (
    state.chatLoading ||
    state.chatSending ||
    Boolean(state.chatRunId) ||
    state.chatStream !== null ||
    state.chatQueue.length > 0
  );
}

function resolveSidebarDefaultAgentId(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return normalizeAgentId(
    state.agentsList?.defaultId ?? snapshot?.sessionDefaults?.defaultAgentId ?? "main",
  );
}

function resolveSidebarSelectedAgentId(state: AppViewState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed) {
    return normalizeAgentId(parsed.agentId);
  }
  const sessionKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  const fallbackAgentId =
    sessionKey === "global" || sessionKey === "unknown"
      ? (state.assistantAgentId ?? resolveSidebarDefaultAgentId(state))
      : resolveSidebarDefaultAgentId(state);
  return normalizeAgentId(fallbackAgentId);
}

function isSidebarSessionForSelectedAgent(
  state: AppViewState,
  row: GatewaySessionRow,
  selectedAgentId: string,
): boolean {
  return isSessionKeyTiedToAgent(row.key, selectedAgentId, resolveSidebarDefaultAgentId(state));
}

function resolveSidebarRecentSessions(state: AppViewState): GatewaySessionRow[] {
  const selectedAgentId = resolveSidebarSelectedAgentId(state);
  const shouldFilterByAgent =
    normalizeOptionalString(state.sessionKey)?.toLowerCase() !== "unknown";
  return (state.sessionsResult?.sessions ?? [])
    .filter(
      (row) =>
        !row.archived &&
        row.kind !== "global" &&
        row.kind !== "unknown" &&
        row.kind !== "cron" &&
        !isCronSessionKey(row.key) &&
        !isSubagentSessionKey(row.key) &&
        !row.spawnedBy &&
        (!shouldFilterByAgent || isSidebarSessionForSelectedAgent(state, row, selectedAgentId)),
    )
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5);
}

export function renderApp(state: AppViewState, application: ApplicationContext) {
  if (!state.connected) {
    return html`
      <openclaw-login-gate
        .props=${{
          basePath: state.basePath ?? "",
          connected: state.connected,
          lastError: state.lastError,
          lastErrorCode: state.lastErrorCode,
          hasToken: Boolean(state.settings.token.trim()),
          hasPassword: Boolean(state.password.trim()),
          gatewayUrl: state.settings.gatewayUrl,
          token: state.settings.token,
          password: state.password,
          showGatewayToken: state.loginShowGatewayToken,
          showGatewayPassword: state.loginShowGatewayPassword,
          onGatewayUrlChange: (value: string) => {
            state.applySettings({ ...state.settings, gatewayUrl: value });
          },
          onTokenChange: (value: string) => {
            state.applySettings({ ...state.settings, token: value });
          },
          onPasswordChange: (value: string) => {
            state.password = value;
          },
          onToggleGatewayToken: () => {
            state.loginShowGatewayToken = !state.loginShowGatewayToken;
          },
          onToggleGatewayPassword: () => {
            state.loginShowGatewayPassword = !state.loginShowGatewayPassword;
          },
          onConnect: () => state.connect(),
        }}
      ></openclaw-login-gate>
      <openclaw-gateway-url-confirmation
        .props=${{
          pendingGatewayUrl: state.pendingGatewayUrl,
          onConfirm: () => state.handleGatewayUrlConfirm(),
          onCancel: () => state.handleGatewayUrlCancel(),
        }}
      ></openclaw-gateway-url-confirmation>
    `;
  }
  const context = { state, navigate: application.navigate };
  return routerOutlet(
    application.routeSnapshot,
    context,
    {
      onNotFound: () =>
        void resolveAppNotFound(application.routeLoadContext).catch(() => undefined),
    },
    (selection) => renderConnectedApp(context, application, selection),
  );
}

function renderConnectedApp(
  context: {
    state: AppViewState;
    navigate: ApplicationContext["navigate"];
  },
  application: ApplicationContext,
  routeView: RouterOutletSelection<RouteId, AppRouteModule, unknown>,
) {
  const { state, navigate } = context;
  const updatableState = state as AppViewState & { requestUpdate?: () => void };
  const requestHostUpdate =
    typeof updatableState.requestUpdate === "function"
      ? () => updatableState.requestUpdate?.()
      : undefined;
  const renderedMatch = routeView.pending ?? routeView.active;
  const renderedRouteId = renderedMatch?.routeId as RouteId | undefined;
  const activeRouteModule = renderedMatch?.module;
  const isChat =
    renderedRouteId === "chat" ||
    (typeof activeRouteModule === "object" &&
      activeRouteModule !== null &&
      "shell" in activeRouteModule &&
      activeRouteModule.shell === "chat");
  const routeOwnsHeader =
    typeof activeRouteModule === "object" &&
    activeRouteModule !== null &&
    "header" in activeRouteModule &&
    activeRouteModule.header === true;
  const headerError = !isChat && state.lastError !== state.chatError ? state.lastError : null;
  const chatHeaderHidden = isChat && (state.onboarding || state.chatHeaderControlsHidden);
  const navDrawerOpen = state.navDrawerOpen && !state.onboarding;
  const navCollapsed = state.settings.navCollapsed && !navDrawerOpen;
  const basePath = state.basePath ?? "";
  const dashboardHeaderContext = resolveDashboardHeaderContext(state);
  const navigateToChatSession = (sessionKey: string) => {
    navigate("chat", { search: searchForSession(sessionKey) });
  };
  const recentSessions = resolveSidebarRecentSessions(state).map((row) => ({
    key: row.key,
    label: resolveSessionDisplayName(row.key, row),
    meta: row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a",
    href: `${pathForRoute("chat", basePath)}${searchForSession(row.key)}`,
    active: row.key === state.sessionKey,
    hasActiveRun: Boolean(row.hasActiveRun),
  }));
  const sidebarBusy = isSidebarSessionBusy(state);
  const newSessionDisabled =
    !state.connected || state.sessionsLoading || sidebarBusy || !state.client;
  const newSessionTitle = !state.connected
    ? "Connect to create a new session"
    : sidebarBusy
      ? "Finish the active run before creating a new session"
      : "New session";
  const routedPage = renderRouterOutlet(appRouter, context, routeView, {
    retryContext: application.routeLoadContext,
  });
  return html`
    <openclaw-command-palette
      .props=${{
        open: state.paletteOpen,
        query: state.paletteQuery,
        activeIndex: state.paletteActiveIndex,
        onOpen: () => {
          void refreshSlashCommands({
            client: state.client,
            agentId: resolveAgentIdForSession(state as never),
          }).finally(requestHostUpdate);
        },
        onToggle: () => {
          state.paletteOpen = !state.paletteOpen;
        },
        onQueryChange: (q: string) => {
          state.paletteQuery = q;
        },
        onActiveIndexChange: (i: number) => {
          state.paletteActiveIndex = i;
        },
        onNavigate: (routeId: RouteId) => {
          navigate(routeId);
        },
        onSlashCommand: (cmd: string) => {
          navigate("chat");
          state.handleChatDraftChange(cmd.endsWith(" ") ? cmd : `${cmd} `);
        },
      }}
    ></openclaw-command-palette>
    <div
      class="shell ${isChat ? "shell--chat" : ""} ${navCollapsed
        ? "shell--nav-collapsed"
        : ""} ${navDrawerOpen ? "shell--nav-drawer-open" : ""} ${state.onboarding
        ? "shell--onboarding"
        : ""}"
      style=${styleMap(
        state.chatMessageMaxWidth ? { "--chat-message-max-width": state.chatMessageMaxWidth } : {},
      )}
    >
      <button
        type="button"
        class="shell-nav-backdrop"
        aria-label="${t("nav.collapse")}"
        @click=${() => {
          state.navDrawerOpen = false;
        }}
      ></button>
      <openclaw-app-topbar
        .routeId=${renderedRouteId}
        .basePath=${state.basePath}
        .agentLabel=${dashboardHeaderContext.agentLabel}
        .navDrawerOpen=${navDrawerOpen}
        .onboarding=${state.onboarding}
        .routeOwnsHeader=${routeOwnsHeader}
        .headerError=${headerError}
        .themeMode=${state.themeMode}
        .onToggleDrawer=${() => {
          state.navDrawerOpen = !navDrawerOpen;
        }}
        .onOpenPalette=${() => {
          state.paletteOpen = !state.paletteOpen;
        }}
        .onNavigate=${navigate}
        @theme-change=${(
          event: CustomEvent<{ mode: AppViewState["themeMode"]; element: HTMLElement }>,
        ) => state.setThemeMode(event.detail.mode, { element: event.detail.element })}
      ></openclaw-app-topbar>
      <div class="shell-nav">
        <openclaw-app-sidebar
          .basePath=${basePath}
          .activeRouteId=${renderedRouteId}
          .collapsed=${navCollapsed}
          .connected=${state.connected}
          .version=${state.hello?.server?.version ?? ""}
          .navGroupsCollapsed=${state.settings.navGroupsCollapsed}
          .recentSessions=${recentSessions}
          .recentSessionsCollapsed=${state.settings.recentSessionsCollapsed}
          .newSessionDisabled=${newSessionDisabled}
          .newSessionTitle=${newSessionTitle}
          .sessionSelector=${renderChatSessionSelect(
            state,
            (_state, sessionKey) => navigateToChatSession(sessionKey),
            {
              compact: navCollapsed,
              sessionSwitcherOnly: true,
              surface: "sidebar",
            },
          )}
          .themeMode=${state.themeMode}
          .onToggleCollapsed=${() => {
            if (navDrawerOpen) {
              state.navDrawerOpen = false;
              return;
            }
            state.applySettings({
              ...state.settings,
              navCollapsed: !state.settings.navCollapsed,
            });
          }}
          .onToggleGroup=${(label: string) => {
            const next = { ...state.settings.navGroupsCollapsed };
            next[label] = !next[label];
            state.applySettings({
              ...state.settings,
              navGroupsCollapsed: next,
            });
          }}
          .onToggleRecentSessions=${() => {
            state.applySettings({
              ...state.settings,
              recentSessionsCollapsed: !state.settings.recentSessionsCollapsed,
            });
          }}
          .onNavigate=${(routeId: RouteId) => {
            if (routeId === "chat") {
              if (!state.sessionKey) {
                const mainSessionKey =
                  (
                    state.hello?.snapshot as
                      | { sessionDefaults?: { mainSessionKey?: string } }
                      | undefined
                  )?.sessionDefaults?.mainSessionKey ?? "main";
                navigateToChatSession(mainSessionKey);
                return;
              }
              if (renderedRouteId !== undefined && renderedRouteId !== "chat") {
                void state.loadAssistantIdentity();
              }
            }
            navigate(routeId);
          }}
          .onRecentSession=${(session: { key: string }) => {
            navigateToChatSession(session.key);
          }}
          .onPreloadRoute=${application.preload}
          @theme-change=${(
            event: CustomEvent<{ mode: AppViewState["themeMode"]; element: HTMLElement }>,
          ) => state.setThemeMode(event.detail.mode, { element: event.detail.element })}
        ></openclaw-app-sidebar>
      </div>
      <main
        class="content ${isChat ? "content--chat" : ""} ${typeof activeRouteModule === "object" &&
        activeRouteModule !== null &&
        "contentClass" in activeRouteModule &&
        typeof activeRouteModule.contentClass === "string"
          ? activeRouteModule.contentClass
          : ""}"
        ?aria-busy=${routeView.status === "loading"}
      >
        <openclaw-update-banner
          .props=${{
            statusBanner: state.updateStatusBanner,
            updateAvailable: state.updateAvailable,
            updateRunning: state.updateRunning,
            connected: state.connected,
            onUpdate: () => runUpdate(state),
            onDismiss: () => {
              state.updateAvailable = null;
            },
          }}
        ></openclaw-update-banner>
        <openclaw-page-header
          .props=${{
            title: renderedRouteId ? titleForRoute(renderedRouteId) : "",
            subtitle: renderedRouteId ? subtitleForRoute(renderedRouteId) : "",
            error: headerError,
            hidden: routeOwnsHeader || isChat || !renderedRouteId,
            inert: chatHeaderHidden,
          }}
        ></openclaw-page-header>
        ${routedPage}
      </main>
      <openclaw-exec-approval
        .props=${{
          queue: state.execApprovalQueue,
          busy: state.execApprovalBusy,
          error: state.execApprovalError,
          onDecision: (
            decision: Parameters<NonNullable<typeof state.handleExecApprovalDecision>>[0],
          ) => state.handleExecApprovalDecision(decision),
        }}
      ></openclaw-exec-approval>
      <openclaw-gateway-url-confirmation
        .props=${{
          pendingGatewayUrl: state.pendingGatewayUrl,
          onConfirm: () => state.handleGatewayUrlConfirm(),
          onCancel: () => state.handleGatewayUrlCancel(),
        }}
      ></openclaw-gateway-url-confirmation>
    </div>
  `;
}
