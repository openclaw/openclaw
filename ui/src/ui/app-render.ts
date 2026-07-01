// Control UI module implements app render behavior.
import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { subtitleForRoute, titleForRoute } from "../app-navigation.ts";
import {
  appRouter,
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
import { resolveAgentIdForSession } from "../pages/chat/chat-avatar.ts";
import { refreshSlashCommands } from "../pages/chat/chat-commands.ts";
import { runUpdate } from "../pages/config/data.ts";
import { resolveDashboardHeaderContext } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";

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
          .navGroupsCollapsed=${state.settings.navGroupsCollapsed}
          .recentSessionsCollapsed=${state.settings.recentSessionsCollapsed}
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
