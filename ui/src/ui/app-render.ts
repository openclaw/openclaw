// Control UI module implements app render behavior.
import { html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { SIDEBAR_SECTIONS, subtitleForRoute, titleForRoute } from "../app-navigation.ts";
import {
  appRouter,
  pathForRoute,
  resolveAppNotFound,
  type ApplicationContext,
  type AppRouteModule,
  type RouteId,
} from "../app-routes.ts";
import {
  renderRouterOutlet,
  routerOutlet,
  type RouterOutletSelection,
} from "../app/router-outlet.ts";
import { t } from "../i18n/index.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { runUpdate } from "../pages/config/data.ts";
import { refreshChatCommands } from "./app-chat.ts";
import {
  createChatSession,
  renderRouteNavItem,
  resolveDashboardHeaderContext,
  renderSidebarConnectionStatus,
  renderTopbarThemeModeToggle,
  switchChatSession,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { renderChatSessionSelect } from "./chat/session-controls.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "./external-link.ts";
import { formatRelativeTimestamp } from "./format.ts";
import { icons } from "./icons.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "./session-display.ts";
import "./components/dashboard-header.ts";
import {
  isSessionKeyTiedToAgent,
  normalizeAgentId,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "./session-key.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type { GatewaySessionRow } from "./types.ts";
import { agentLogoUrl } from "./views/agents-utils.ts";
import { renderCommandPalette } from "./views/command-palette.ts";
import { renderExecApprovalPrompt } from "./views/exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderLoginGate } from "./views/login-gate.ts";

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

function renderSidebarSessions(state: AppViewState, navigate: (routeId: RouteId) => void) {
  const collapsed = state.settings.navCollapsed;
  const busy = isSidebarSessionBusy(state);
  const recent = collapsed ? [] : resolveSidebarRecentSessions(state);
  const newSessionDisabled = !state.connected || state.sessionsLoading || busy || !state.client;
  const newSessionTitle = !state.connected
    ? "Connect to create a new session"
    : busy
      ? "Finish the active run before creating a new session"
      : "New session";

  return html`
    <section class="sidebar-sessions ${collapsed ? "sidebar-sessions--collapsed" : ""}">
      <button
        type="button"
        class="sidebar-new-session"
        title=${newSessionTitle}
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${newSessionDisabled}
        @click=${async () => {
          if (newSessionDisabled) {
            return;
          }
          if (await createChatSession(state, { source: "user" })) {
            navigate("chat");
          }
        }}
      >
        <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
        ${collapsed
          ? nothing
          : html`<span class="sidebar-new-session__label"
              >${t("chat.runControls.newSession")}</span
            >`}
      </button>
      <div class="sidebar-session-select ${collapsed ? "sidebar-session-select--collapsed" : ""}">
        ${renderChatSessionSelect(state, switchChatSession, {
          compact: collapsed,
          sessionSwitcherOnly: true,
          surface: "sidebar",
        })}
      </div>
      ${collapsed || recent.length === 0
        ? nothing
        : html`
            <div
              class="sidebar-recent-sessions ${state.settings.recentSessionsCollapsed
                ? "sidebar-recent-sessions--collapsed"
                : ""}"
              aria-label=${t("overview.cards.recentSessions")}
            >
              <button
                class="sidebar-recent-sessions__label"
                type="button"
                aria-expanded=${String(!state.settings.recentSessionsCollapsed)}
                @click=${() => {
                  state.applySettings({
                    ...state.settings,
                    recentSessionsCollapsed: !state.settings.recentSessionsCollapsed,
                  });
                }}
              >
                <span class="sidebar-recent-sessions__label-text"
                  >${t("usage.sessions.recentShort")}</span
                >
                <span class="sidebar-recent-sessions__chevron"> ${icons.chevronDown} </span>
              </button>
              <div class="sidebar-recent-sessions__list">
                ${recent.map((row) => renderSidebarRecentSession(state, row, navigate))}
              </div>
            </div>
          `}
    </section>
  `;
}

function renderSidebarRecentSession(
  state: AppViewState,
  row: GatewaySessionRow,
  navigate: (routeId: RouteId) => void,
) {
  const active = row.key === state.sessionKey;
  const label = resolveSessionDisplayName(row.key, row);
  const meta = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a";
  const href = `${pathForRoute("chat", state.basePath)}?session=${encodeURIComponent(row.key)}`;
  return html`
    <a
      href=${href}
      class="sidebar-recent-session ${active ? "sidebar-recent-session--active" : ""}"
      data-session-key=${row.key}
      title=${`${label} · ${row.key}`}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (row.key !== state.sessionKey) {
          switchChatSession(state, row.key);
        }
        navigate("chat");
      }}
    >
      <span class="sidebar-recent-session__dot" aria-hidden="true"></span>
      <span class="sidebar-recent-session__body">
        <span class="sidebar-recent-session__name">${label}</span>
        <span class="sidebar-recent-session__meta">${meta}</span>
      </span>
      ${row.hasActiveRun
        ? html`<span
            class="sidebar-recent-session__live"
            aria-label=${t("sessions.sessionDetails.activeRun")}
          ></span>`
        : nothing}
    </a>
  `;
}

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isUpdateBannerDismissed(updateAvailable: unknown): boolean {
  const dismissed = loadDismissedUpdateBanner();
  if (!dismissed) {
    return false;
  }
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  return Boolean(
    latestVersion && dismissed.latestVersion === latestVersion && dismissed.channel === channel,
  );
}

function dismissUpdateBanner(updateAvailable: unknown) {
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  if (!latestVersion) {
    return;
  }
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  const payload: DismissedUpdateBanner = {
    latestVersion,
    channel,
    dismissedAtMs: Date.now(),
  };
  try {
    getSafeLocalStorage()?.setItem(UPDATE_BANNER_DISMISS_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export function renderApp(state: AppViewState, application: ApplicationContext) {
  if (!state.connected) {
    return html` ${renderLoginGate(state)} ${renderGatewayUrlConfirmation(state)} `;
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
    navigate: (routeId: RouteId) => void;
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
  const routedPage = renderRouterOutlet(appRouter, context, routeView, {
    retryContext: application.routeLoadContext,
  });
  return html`
    ${renderCommandPalette({
      open: state.paletteOpen,
      query: state.paletteQuery,
      activeIndex: state.paletteActiveIndex,
      onOpen: () => {
        void refreshChatCommands(state).finally(requestHostUpdate);
      },
      onToggle: () => {
        state.paletteOpen = !state.paletteOpen;
      },
      onQueryChange: (q) => {
        state.paletteQuery = q;
      },
      onActiveIndexChange: (i) => {
        state.paletteActiveIndex = i;
      },
      onNavigate: (routeId) => {
        navigate(routeId);
      },
      onSlashCommand: (cmd) => {
        navigate("chat");
        state.handleChatDraftChange(cmd.endsWith(" ") ? cmd : `${cmd} `);
      },
    })}
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
      <header
        class="topbar"
        ?inert=${state.onboarding}
        aria-hidden=${state.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <button
            type="button"
            class="sidebar-menu-trigger topbar-nav-toggle"
            @click=${() => {
              state.navDrawerOpen = !navDrawerOpen;
            }}
            title="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-label="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-expanded=${navDrawerOpen}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
          </button>
          <div class="topnav-shell__content">
            <dashboard-header
              .routeId=${renderedRouteId}
              .basePath=${state.basePath}
              .agentLabel=${dashboardHeaderContext.agentLabel}
              @navigate=${(event: CustomEvent<RouteId>) => {
                navigate(event.detail);
              }}
            ></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            <button
              class="topbar-search"
              @click=${() => {
                state.paletteOpen = !state.paletteOpen;
              }}
              title=${t("chat.commandPaletteTitle")}
              aria-label=${t("chat.openCommandPalette")}
            >
              <span class="topbar-search__label">${t("common.search")}</span>
              <kbd class="topbar-search__kbd">⌘K</kbd>
            </button>
            <div class="topbar-status">
              ${routeOwnsHeader && headerError
                ? html`<div class="pill danger">${headerError}</div>`
                : nothing}
              ${renderTopbarThemeModeToggle(state)}
            </div>
          </div>
        </div>
      </header>
      <div class="shell-nav">
        <aside class="sidebar ${navCollapsed ? "sidebar--collapsed" : ""}">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <div class="sidebar-brand">
                ${navCollapsed
                  ? nothing
                  : html`
                      <img
                        class="sidebar-brand__logo"
                        src="${agentLogoUrl(basePath)}"
                        alt="OpenClaw"
                      />
                      <span class="sidebar-brand__copy">
                        <span class="sidebar-brand__eyebrow">${t("nav.control")}</span>
                        <span class="sidebar-brand__title">OpenClaw</span>
                      </span>
                    `}
              </div>
              <button
                type="button"
                class="nav-collapse-toggle"
                @click=${() => {
                  if (navDrawerOpen) {
                    state.navDrawerOpen = false;
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    navCollapsed: !state.settings.navCollapsed,
                  });
                }}
                title="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                aria-label="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
              >
                <span class="nav-collapse-toggle__icon" aria-hidden="true"
                  >${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
                >
              </button>
            </div>
            <div class="sidebar-shell__body">
              ${renderSidebarSessions(state, navigate)}
              <nav class="sidebar-nav">
                ${SIDEBAR_SECTIONS.map((group) => {
                  const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
                  const showItems = navCollapsed || !isGroupCollapsed;

                  return html`
                    <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
                      ${!navCollapsed
                        ? html`
                            <button
                              class="nav-section__label"
                              @click=${() => {
                                const next = { ...state.settings.navGroupsCollapsed };
                                next[group.label] = !isGroupCollapsed;
                                state.applySettings({
                                  ...state.settings,
                                  navGroupsCollapsed: next,
                                });
                              }}
                              aria-expanded=${showItems}
                            >
                              <span class="nav-section__label-text"
                                >${t(`nav.${group.label}`)}</span
                              >
                              <span class="nav-section__chevron"> ${icons.chevronDown} </span>
                            </button>
                          `
                        : nothing}
                      <div class="nav-section__items">
                        ${group.routes.map((routeId) =>
                          renderRouteNavItem(state, routeId, {
                            activeRouteId: renderedRouteId,
                            collapsed: navCollapsed,
                            onNavigate: navigate,
                            preloadRoute: application.preload,
                          }),
                        )}
                      </div>
                    </section>
                  `;
                })}
              </nav>
            </div>
            <div class="sidebar-shell__footer">
              <div class="sidebar-utility-group">
                <a
                  class="nav-item nav-item--external sidebar-utility-link"
                  href="https://docs.openclaw.ai"
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  title=${t("chat.docsOpensInNewTab", { label: t("common.docs") })}
                >
                  <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
                  ${!navCollapsed
                    ? html`
                        <span class="nav-item__text">${t("common.docs")}</span>
                        <span class="nav-item__external-icon">${icons.externalLink}</span>
                      `
                    : nothing}
                </a>
                <div class="sidebar-mode-switch">${renderTopbarThemeModeToggle(state)}</div>
                ${(() => {
                  const version = state.hello?.server?.version ?? "";
                  return version
                    ? html`
                        <div class="sidebar-version" title=${`v${version}`}>
                          ${!navCollapsed
                            ? html`
                                <span class="sidebar-version__label">${t("common.version")}</span>
                                <span class="sidebar-version__text">v${version}</span>
                                ${renderSidebarConnectionStatus(state)}
                              `
                            : html` ${renderSidebarConnectionStatus(state)} `}
                        </div>
                      `
                    : nothing;
                })()}
              </div>
            </div>
          </div>
        </aside>
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
        ${state.updateStatusBanner
          ? html`<div class="callout ${state.updateStatusBanner.tone}" role="alert">
              ${state.updateStatusBanner.text}
            </div>`
          : nothing}
        ${state.updateAvailable &&
        state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion &&
        !isUpdateBannerDismissed(state.updateAvailable)
          ? html`<div class="update-banner callout danger" role="alert">
              <strong>${t("chat.updateAvailable")}</strong> v${state.updateAvailable.latestVersion}
              (${t("chat.runningVersion", { version: state.updateAvailable.currentVersion })}).
              <button
                class="btn btn--sm update-banner__btn"
                ?disabled=${state.updateRunning || !state.connected}
                @click=${() => runUpdate(state)}
              >
                ${state.updateRunning ? t("chat.updating") : t("chat.updateNow")}
              </button>
              <button
                class="update-banner__close"
                type="button"
                title=${t("common.dismiss")}
                aria-label=${t("chat.dismissUpdateBanner")}
                @click=${() => {
                  dismissUpdateBanner(state.updateAvailable);
                  state.updateAvailable = null;
                }}
              >
                ${icons.x}
              </button>
            </div>`
          : nothing}
        ${routeOwnsHeader || isChat || !renderedRouteId
          ? nothing
          : html`<section
              class=${chatHeaderHidden
                ? "content-header content-header--chat-hidden"
                : "content-header"}
              ?inert=${chatHeaderHidden}
              aria-hidden=${chatHeaderHidden ? "true" : nothing}
            >
              <div>
                <div class="page-title">${titleForRoute(renderedRouteId)}</div>
                <div class="page-sub">${subtitleForRoute(renderedRouteId)}</div>
              </div>
              <div class="page-meta">
                ${headerError ? html`<div class="pill danger">${headerError}</div>` : nothing}
              </div>
            </section>`}
        ${routedPage}
      </main>
      ${renderExecApprovalPrompt(state)} ${renderGatewayUrlConfirmation(state)} ${nothing}
    </div>
  `;
}
