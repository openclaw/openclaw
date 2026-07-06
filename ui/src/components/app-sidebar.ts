import { consume } from "@lit/context";
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  scheduleRoutePreload,
  type NavigationRouteId,
  SIDEBAR_NAV_ROUTES,
  type SidebarNavRoute,
  sidebarMoreRoutes,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "../app/context.ts";
import "./theme-mode-toggle.ts";
import "./session-picker.ts";
import "./tooltip.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { resolveSessionNavigation, searchForSession } from "../lib/sessions/index.ts";
import {
  buildAgentMainSessionKey,
  canArchiveSessionRow,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import {
  resolvePreferredSessionForAgent,
  resolveSessionAgentFilterOptions,
} from "../lib/sessions/session-options.ts";
import { pluginTabKey, pluginTabSearch } from "../pages/plugin/route.ts";
import { icons, type IconName } from "./icons.ts";

type SidebarRecentSession = {
  key: string;
  label: string;
  meta: string;
  href: string;
  active: boolean;
  hasActiveRun: boolean;
  kind?: string;
  pinned: boolean;
};

function shouldHandleNavigationClick(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export class AppSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) activePluginTabId = "";
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) collapsed = false;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) sidebarPinnedRoutes: readonly SidebarNavRoute[] =
    DEFAULT_SIDEBAR_PINNED_ROUTES;
  @property({ attribute: false }) sidebarMoreExpanded = false;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) onToggleMore?: () => void;
  @property({ attribute: false }) onUpdatePinnedRoutes?: (routes: SidebarNavRoute[]) => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;
  @state() private customizeMenuPosition: { x: number; y: number } | null = null;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsAgentId: string | null = null;
  @state() private sessionsLoading = false;

  private stopSessionsSubscription: (() => void) | undefined;
  private stopAgentsSubscription: (() => void) | undefined;
  private stopAgentSelectionSubscription: (() => void) | undefined;
  private stopGatewaySubscription: (() => void) | undefined;
  private customizeMenuTrigger: HTMLElement | null = null;
  private sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  private gatewayClient: GatewayBrowserClient | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    this.startSubscriptions();
  }

  override disconnectedCallback() {
    this.closeCustomizeMenu();
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    this.stopAgentsSubscription?.();
    this.stopAgentsSubscription = undefined;
    this.stopAgentSelectionSubscription?.();
    this.stopAgentSelectionSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.gatewayClient = null;
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
    super.disconnectedCallback();
  }

  private startSubscriptions() {
    const context = this.context;
    if (
      !context ||
      this.stopSessionsSubscription ||
      this.stopAgentsSubscription ||
      this.stopAgentSelectionSubscription ||
      this.stopGatewaySubscription
    ) {
      return;
    }
    this.updateGatewayClient(context.gateway.snapshot);
    this.updateSessions(context.sessions.state);
    this.stopSessionsSubscription = context.sessions.subscribe((snapshot) => {
      this.updateSessions(snapshot);
    });
    this.stopAgentsSubscription = context.agents.subscribe(() => {
      this.requestUpdate();
    });
    this.stopAgentSelectionSubscription = context.agentSelection.subscribe(() => {
      this.requestUpdate();
    });
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) => {
      this.updateGatewayClient(snapshot);
      this.requestUpdate();
    });
  }

  override updated() {
    this.startSubscriptions();
  }

  private readonly updateSessions = (snapshot: {
    result: SessionsListResult | null;
    agentId: string | null;
    loading: boolean;
  }) => {
    this.sessionsResult = snapshot.result;
    this.sessionsAgentId = snapshot.agentId;
    this.sessionsLoading = snapshot.loading;
    if (snapshot.result && snapshot.agentId) {
      this.sessionRowsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result.sessions;
    }
  };

  private updateGatewayClient(snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
  }) {
    const client = snapshot.connected ? snapshot.client : null;
    if (client === this.gatewayClient) {
      return;
    }
    this.sessionRowsByAgent = {};
    this.gatewayClient = client;
  }

  private getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  private getSessionNavigationState() {
    const context = this.context;
    const routeSessionKey = this.getRouteSessionKey();
    const navigation = resolveSessionNavigation({
      result: this.sessionsResult,
      resultAgentId: this.sessionsAgentId,
      sessionKey: routeSessionKey,
      assistantAgentId:
        context?.agentSelection.state.selectedId ?? context?.gateway.snapshot.assistantAgentId,
      hello: context?.gateway.snapshot.hello,
    });
    const toSidebarSession = (row: SessionsListResult["sessions"][number]) => ({
      key: row.key,
      label: resolveSessionDisplayName(row.key, row),
      meta: row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "",
      href: `${pathForRoute("chat", context?.basePath ?? "")}${searchForSession(row.key)}`,
      active: row.key === navigation.currentSessionKey,
      hasActiveRun: Boolean(row.hasActiveRun),
      kind: row.kind,
      pinned: row.pinned === true,
    });
    const activeSession = navigation.selectedSession
      ? toSidebarSession(navigation.selectedSession)
      : null;
    const recentSessions = navigation.recentSessions
      .slice(activeSession ? 1 : 0)
      .map(toSidebarSession);
    const newSessionDisabled =
      !this.connected || this.sessionsLoading || Boolean(navigation.selectedSession?.hasActiveRun);
    return {
      routeSessionKey: navigation.currentSessionKey,
      selectedAgentId: navigation.selectedAgentId,
      defaultAgentId: navigation.defaultAgentId,
      activeSession,
      recentSessions,
      newSessionDisabled,
      newSessionTitle: !this.connected
        ? "Connect to create a new session"
        : navigation.selectedSession?.hasActiveRun
          ? "Finish the active run before creating a new session"
          : "New session",
    };
  }

  private readonly selectSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    this.onNavigate?.("chat", {
      search: searchForSession(sessionKey),
    });
  };

  private readonly replaceCurrentSession = (sessionKey: string) => {
    this.context?.gateway.setSessionKey(sessionKey);
    if (this.activeRouteId === "chat") {
      this.onNavigate?.("chat", {
        search: searchForSession(sessionKey),
      });
    }
  };

  private readonly selectAgent = (agentId: string) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const { routeSessionKey, selectedAgentId } = this.getSessionNavigationState();
    const nextAgentId = normalizeAgentId(agentId);
    if (nextAgentId === normalizeAgentId(selectedAgentId)) {
      return;
    }
    const nextSessionKey = resolvePreferredSessionForAgent(
      {
        agentsList: context.agents.state.agentsList,
        chatAgentSessionRowsByAgent: this.sessionRowsByAgent,
        sessionsResult: this.sessionsResult,
        sessionsResultAgentId: this.sessionsAgentId,
        sessionKey: routeSessionKey,
      },
      nextAgentId,
    );
    context.agentSelection.set(nextAgentId);
    this.selectSession(nextSessionKey);
  };

  private readonly createSession = async (worktree = false) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const { routeSessionKey, selectedAgentId, newSessionDisabled } =
      this.getSessionNavigationState();
    if (newSessionDisabled) {
      return;
    }
    const nextSessionKey = await context.sessions.create({
      currentSessionKey: routeSessionKey,
      agentId: selectedAgentId,
      ...(worktree ? { worktree: true } : {}),
    });
    if (nextSessionKey) {
      this.selectSession(nextSessionKey);
    }
  };

  private readonly patchSession = async (
    session: SidebarRecentSession,
    patch: { archived?: boolean; pinned?: boolean },
  ) => {
    const context = this.context;
    if (!context || !this.connected) {
      return;
    }
    const { selectedAgentId } = this.getSessionNavigationState();
    const agentId = parseAgentSessionKey(session.key)?.agentId;
    try {
      const patched = await context.sessions.patch(session.key, patch, agentId ? { agentId } : {});
      if (!patched || patch.archived !== true || !session.active) {
        return;
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId: agentId ?? selectedAgentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
          }),
        }),
      );
    } catch {
      // Session capability publishes the actionable error for the owning page.
    }
  };

  private preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    scheduleRoutePreload(
      this.routePreloadTimers,
      routeId,
      event,
      (nextRouteId) => this.onPreloadRoute?.(nextRouteId),
      routeId === this.activeRouteId || !this.isRouteEnabled(routeId),
      immediate,
    );
  }

  private readonly cancelPreload = (event: Event) => {
    cancelRoutePreload(this.routePreloadTimers, event);
  };

  private isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.enabledRouteIds?.includes(routeId) ?? true;
  }

  private readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    if (this.collapsed) {
      return;
    }
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  private openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    // Clamp so the fixed-position menu never overflows the viewport.
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.customizeMenuTrigger = trigger;
    this.customizeMenuPosition = {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    };
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-customize-menu__item")?.focus();
    });
  }

  private closeCustomizeMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.customizeMenuTrigger;
    this.customizeMenuTrigger = null;
    this.customizeMenuPosition = null;
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const menu = this.querySelector(".sidebar-customize-menu");
    if (menu && event.composedPath().includes(menu)) {
      return;
    }
    this.closeCustomizeMenu();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.closeCustomizeMenu({ restoreFocus: true });
    }
  };

  private togglePinnedRoute(routeId: SidebarNavRoute) {
    const pinned = this.sidebarPinnedRoutes;
    const next = pinned.includes(routeId)
      ? pinned.filter((route) => route !== routeId)
      : [...pinned, routeId];
    this.onUpdatePinnedRoutes?.(next);
  }

  private renderCustomizeMenu() {
    const position = this.customizeMenuPosition;
    if (!position) {
      return nothing;
    }
    return html`
      <div
        class="sidebar-customize-menu"
        role="menu"
        aria-label=${t("nav.customize")}
        style="left: ${position.x}px; top: ${position.y}px;"
      >
        <div class="sidebar-customize-menu__title">${t("nav.customize")}</div>
        ${SIDEBAR_NAV_ROUTES.filter((routeId) => this.isRouteEnabled(routeId)).map((routeId) => {
          const pinned = this.sidebarPinnedRoutes.includes(routeId);
          return html`
            <button
              type="button"
              class="sidebar-customize-menu__item"
              role="menuitemcheckbox"
              aria-checked=${String(pinned)}
              @click=${() => this.togglePinnedRoute(routeId)}
            >
              <span class="sidebar-customize-menu__check" aria-hidden="true">
                ${pinned ? icons.check : nothing}
              </span>
              <span class="nav-item__icon" aria-hidden="true"
                >${icons[navigationIconForRoute(routeId)]}</span
              >
              <span class="sidebar-customize-menu__text">${titleForRoute(routeId)}</span>
            </button>
          `;
        })}
        <div class="sidebar-customize-menu__separator" role="separator"></div>
        <button
          type="button"
          class="sidebar-customize-menu__item"
          role="menuitem"
          @click=${() => {
            this.onUpdatePinnedRoutes?.([...DEFAULT_SIDEBAR_PINNED_ROUTES]);
            this.closeCustomizeMenu({ restoreFocus: true });
          }}
        >
          <span class="sidebar-customize-menu__check" aria-hidden="true"></span>
          <span class="nav-item__icon" aria-hidden="true">${icons.refresh}</span>
          <span class="sidebar-customize-menu__text">${t("nav.customizeReset")}</span>
        </button>
      </div>
    `;
  }

  private renderRoute(routeId: NavigationRouteId) {
    const active =
      routeId === "config"
        ? this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId)
        : this.activeRouteId === routeId;
    const enabled = this.isRouteEnabled(routeId);
    if (!enabled) {
      return html`
        <span class="nav-item nav-item--disabled" aria-disabled="true">
          <span class="nav-item__icon" aria-hidden="true"
            >${icons[navigationIconForRoute(routeId)]}</span
          >
          ${!this.collapsed
            ? html`<span class="nav-item__text">${titleForRoute(routeId)}</span>`
            : nothing}
        </span>
      `;
    }
    const routeSessionKey = routeId === "chat" ? this.getRouteSessionKey() : "";
    const href =
      routeSessionKey && routeId === "chat"
        ? `${pathForRoute("chat", this.basePath)}${searchForSession(routeSessionKey)}`
        : pathForRoute(routeId, this.basePath);
    const label = titleForRoute(routeId);
    const link = html`
      <a
        href=${href}
        class="nav-item ${active ? "nav-item--active" : ""}"
        @focus=${(event: Event) => this.preloadRoute(routeId, event)}
        @blur=${this.cancelPreload}
        @pointerenter=${(event: Event) => this.preloadRoute(routeId, event)}
        @pointerleave=${this.cancelPreload}
        @touchstart=${(event: TouchEvent) => this.preloadRoute(routeId, event, true)}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.onNavigate?.(
            routeId,
            routeId === "chat" && routeSessionKey
              ? {
                  search: searchForSession(routeSessionKey),
                }
              : undefined,
          );
        }}
      >
        <span class="nav-item__icon" aria-hidden="true"
          >${icons[navigationIconForRoute(routeId)]}</span
        >
        ${!this.collapsed ? html`<span class="nav-item__text">${label}</span>` : nothing}
      </a>
    `;
    return this.collapsed
      ? html`<openclaw-tooltip .content=${label}>${link}</openclaw-tooltip>`
      : link;
  }

  /** Dynamic plugin tabs stay in More; only stable static route ids can be persisted as pins. */
  private pluginTabs(): GatewayControlUiPluginTab[] {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return ["chat", "control", "agent", "settings"].flatMap((group) =>
      tabs.filter((tab) => (tab.group ?? "control") === group),
    );
  }

  private renderPluginTab(tab: GatewayControlUiPluginTab) {
    const ref = { pluginId: tab.pluginId, id: tab.id };
    const search = pluginTabSearch(ref);
    const href = `${pathForRoute("plugin", this.basePath)}${search}`;
    const active = this.activeRouteId === "plugin" && this.activePluginTabId === pluginTabKey(ref);
    const iconName = tab.icon && Object.hasOwn(icons, tab.icon) ? (tab.icon as IconName) : "puzzle";
    const link = html`
      <a
        href=${href}
        class="nav-item ${active ? "nav-item--active" : ""}"
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.onNavigate?.("plugin", { search });
        }}
      >
        <span class="nav-item__icon" aria-hidden="true">${icons[iconName]}</span>
        ${!this.collapsed ? html`<span class="nav-item__text">${tab.label}</span>` : nothing}
      </a>
    `;
    return this.collapsed
      ? html`<openclaw-tooltip .content=${tab.label}>${link}</openclaw-tooltip>`
      : link;
  }

  private renderRecentSession(session: SidebarRecentSession) {
    const context = this.context;
    const archiveAllowed = canArchiveSessionRow(
      session,
      resolveUiConfiguredMainKey({
        agentsList: context?.agents.state.agentsList,
        hello: context?.gateway.snapshot.hello,
      }),
    );
    const rowClass = [
      "sidebar-recent-session",
      "session-row-host",
      session.active ? "sidebar-recent-session--active" : "",
      session.pinned ? "session-row-host--pinned" : "",
      session.hasActiveRun ? "session-row-host--running" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const row = html`
      <div
        class=${rowClass}
        data-session-key=${session.key}
        @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
        @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
      >
        <a
          href=${session.href}
          class="sidebar-recent-session__link"
          title=${`${session.label} · ${session.key}`}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.selectSession(session.key);
          }}
        >
          <span class="sidebar-recent-session__name hover-marquee">${session.label}</span>
        </a>
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail">
            ${session.hasActiveRun
              ? html`<span
                  class="session-run-spinner"
                  role="img"
                  aria-label=${t("sessionsView.activeRun")}
                  title=${t("sessionsView.activeRun")}
                ></span>`
              : session.meta}
          </span>
          <span class="session-row-actions">
            <button
              class="session-action"
              data-sidebar-session-archive="true"
              type="button"
              title=${t("sessionsView.archiveSession")}
              aria-label=${t("sessionsView.archiveSession")}
              ?disabled=${!this.connected || !archiveAllowed}
              @click=${() => void this.patchSession(session, { archived: true })}
            >
              ${icons.archive}
            </button>
            <button
              class="session-action session-action--pin"
              data-sidebar-session-pin="true"
              type="button"
              title=${session.pinned
                ? t("sessionsView.unpinSession")
                : t("sessionsView.pinSession")}
              aria-label=${session.pinned
                ? t("sessionsView.unpinSession")
                : t("sessionsView.pinSession")}
              ?disabled=${!this.connected}
              @click=${() => void this.patchSession(session, { pinned: !session.pinned })}
            >
              ${icons.pin}
            </button>
          </span>
        </span>
      </div>
    `;
    // Hover marquee state mutates the row DOM. Keying prevents that state from
    // leaking when Lit reuses this slot for another session after navigation.
    return keyed(session.key, row);
  }

  private renderSessions() {
    const context = this.context;
    const {
      routeSessionKey,
      selectedAgentId,
      defaultAgentId,
      activeSession,
      recentSessions,
      newSessionDisabled,
      newSessionTitle,
    } = this.getSessionNavigationState();
    const workspaceGit =
      context?.agents.state.agentsList?.agents.find(
        (agent) => normalizeAgentId(agent.id) === normalizeAgentId(selectedAgentId),
      )?.workspaceGit === true;
    const newSessionButton = html`
      <button
        type="button"
        class="sidebar-new-session"
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${newSessionDisabled}
        @click=${() => void this.createSession()}
      >
        <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
        ${this.collapsed
          ? nothing
          : html`<span class="sidebar-new-session__label"
              >${t("chat.runControls.newSession")}</span
            >`}
      </button>
    `;
    const newSessionControl = workspaceGit
      ? html`
          <div class="sidebar-new-session-group">
            ${newSessionButton}
            <button
              type="button"
              class="sidebar-new-session sidebar-new-session--worktree"
              title=${t("chat.runControls.newSessionWorktree")}
              aria-label=${t("chat.runControls.newSessionWorktree")}
              ?disabled=${newSessionDisabled}
              @click=${() => void this.createSession(true)}
            >
              <span class="sidebar-new-session__icon" aria-hidden="true">${icons.gitBranch}</span>
            </button>
          </div>
        `
      : newSessionButton;
    // Pinned rows stay separate from the recency-capped chat list; the active
    // session leads whichever group owns it.
    const allRows = [...(activeSession ? [activeSession] : []), ...recentSessions];
    const pinnedRows = allRows.filter((session) => session.pinned);
    const chatRows = allRows.filter((session) => !session.pinned);
    return html`
      <section class="sidebar-sessions ${this.collapsed ? "sidebar-sessions--collapsed" : ""}">
        ${this.collapsed
          ? html`<openclaw-tooltip .content=${newSessionTitle}
              >${newSessionControl}</openclaw-tooltip
            >`
          : newSessionControl}
        ${this.collapsed
          ? nothing
          : html`
              <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
                ${pinnedRows.length === 0
                  ? nothing
                  : html`
                      <div class="sidebar-recent-sessions__group">
                        <div class="sidebar-recent-sessions__head">
                          <span class="sidebar-recent-sessions__label-text"
                            >${t("sessionsView.pinned")}</span
                          >
                        </div>
                        <div class="sidebar-recent-sessions__list">
                          ${pinnedRows.map((session) => this.renderRecentSession(session))}
                        </div>
                      </div>
                    `}
                <div class="sidebar-recent-sessions__group">
                  <div class="sidebar-recent-sessions__head">
                    <span class="sidebar-recent-sessions__label-text"
                      >${t("sessionsView.title")}</span
                    >
                    <openclaw-session-picker
                      .sessions=${context?.sessions}
                      .sessionsResult=${this.sessionsResult}
                      .currentSessionKey=${routeSessionKey}
                      .agentId=${selectedAgentId}
                      .defaultAgentId=${defaultAgentId}
                      .mainKey=${resolveUiConfiguredMainKey({
                        agentsList: context?.agents.state.agentsList,
                        hello: context?.gateway.snapshot.hello,
                      })}
                      .connected=${this.connected}
                      .onSelectSession=${this.selectSession}
                      .onReplaceCurrentSession=${this.replaceCurrentSession}
                    ></openclaw-session-picker>
                  </div>
                  ${this.renderAgentFilter(routeSessionKey, selectedAgentId)}
                  <div class="sidebar-recent-sessions__list">
                    ${allRows.length === 0
                      ? this.renderChatFallback()
                      : chatRows.map((session) => this.renderRecentSession(session))}
                  </div>
                  <a
                    href=${pathForRoute("sessions", this.basePath)}
                    class="sidebar-recent-sessions__all"
                    @click=${(event: MouseEvent) => {
                      if (!shouldHandleNavigationClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      this.onNavigate?.("sessions");
                    }}
                  >
                    <span>${t("chat.sidebar.allSessions")}</span>
                    <span class="sidebar-recent-sessions__all-icon" aria-hidden="true"
                      >${icons.chevronRight}</span
                    >
                  </a>
                </div>
              </div>
            `}
      </section>
    `;
  }

  private renderAgentFilter(sessionKey: string, selectedAgentId: string) {
    const options = resolveSessionAgentFilterOptions({
      agentsList: this.context?.agents.state.agentsList,
      sessionsResult: this.sessionsResult,
      sessionsResultAgentId: this.sessionsAgentId,
      sessionKey,
    });
    if (options.length <= 1) {
      return nothing;
    }
    const selectedLabel =
      options.find((option) => option.id === selectedAgentId)?.label ?? selectedAgentId;
    return html`
      <div class="sidebar-agent-filter">
        <label class="field chat-controls__session chat-controls__agent">
          <select
            data-chat-agent-filter="true"
            aria-label=${t("chat.selectors.agentFilter")}
            title=${selectedLabel}
            .value=${selectedAgentId}
            ?disabled=${!this.connected}
            @change=${(event: Event) => this.selectAgent((event.target as HTMLSelectElement).value)}
          >
            ${options.map(
              (option) =>
                html`<option value=${option.id} ?selected=${option.id === selectedAgentId}>
                  ${option.label}
                </option>`,
            )}
          </select>
        </label>
      </div>
    `;
  }

  private renderMoreSection() {
    if (this.collapsed) {
      return nothing;
    }
    const moreRoutes = sidebarMoreRoutes(this.sidebarPinnedRoutes);
    const expanded = this.sidebarMoreExpanded;
    return html`
      <section class="nav-section nav-section--more ${expanded ? "" : "nav-section--collapsed"}">
        <button
          class="nav-section__label"
          @click=${() => this.onToggleMore?.()}
          aria-expanded=${String(expanded)}
        >
          <span class="nav-section__label-text">${t("nav.more")}</span>
          <span class="nav-section__chevron"> ${icons.chevronDown} </span>
        </button>
        <div class="nav-section__items">
          ${moreRoutes.map((routeId) => this.renderRoute(routeId))}
          ${this.pluginTabs().map((tab) => this.renderPluginTab(tab))}
          <button
            type="button"
            class="nav-item nav-item--action"
            @click=${(event: MouseEvent) => {
              const trigger = event.currentTarget as HTMLElement;
              const rect = trigger.getBoundingClientRect();
              this.openCustomizeMenu(rect.left, rect.bottom + 4, trigger);
            }}
          >
            <span class="nav-item__icon" aria-hidden="true">${icons.penLine}</span>
            <span class="nav-item__text">${t("nav.customize")}</span>
          </button>
        </div>
      </section>
    `;
  }

  private renderChatFallback() {
    return html`
      <a
        href=${pathForRoute("chat", this.basePath)}
        class="sidebar-recent-session ${this.activeRouteId === "chat"
          ? "sidebar-recent-session--active"
          : ""}"
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.onNavigate?.("chat");
        }}
      >
        <span class="sidebar-recent-session__body">
          <span class="sidebar-recent-session__name">${t("nav.chat")}</span>
        </span>
      </a>
    `;
  }

  override render() {
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const settingsActive =
      this.activeRouteId !== undefined && isSettingsNavigationRoute(this.activeRouteId);
    return html`
      <aside class="sidebar ${this.collapsed ? "sidebar--collapsed" : ""}">
        <div class="sidebar-shell">
          <div class="sidebar-shell__body">
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              ${this.collapsed ? this.renderRoute("chat") : nothing}
              <div class="nav-section__items">
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
              </div>
              ${this.renderMoreSection()}
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <div class="sidebar-footer-bar">
              <openclaw-tooltip .content=${gatewayStatus}>
                <span
                  class="sidebar-status__dot ${this.connected
                    ? "sidebar-connection-status--online"
                    : "sidebar-connection-status--offline"}"
                  role="img"
                  aria-live="polite"
                  aria-label=${gatewayStatus}
                ></span>
              </openclaw-tooltip>
              <span class="sidebar-footer-bar__spacer"></span>
              <openclaw-tooltip .content=${titleForRoute("config")}>
                <a
                  href=${pathForRoute("config", this.basePath)}
                  class="sidebar-footer-icon ${settingsActive ? "sidebar-footer-icon--active" : ""}"
                  aria-label=${titleForRoute("config")}
                  aria-current=${settingsActive ? "page" : nothing}
                  @focus=${(event: Event) => this.preloadRoute("config", event)}
                  @blur=${this.cancelPreload}
                  @pointerenter=${(event: Event) => this.preloadRoute("config", event)}
                  @pointerleave=${this.cancelPreload}
                  @touchstart=${(event: TouchEvent) => this.preloadRoute("config", event, true)}
                  @click=${(event: MouseEvent) => {
                    if (!shouldHandleNavigationClick(event)) {
                      return;
                    }
                    event.preventDefault();
                    this.onNavigate?.("config");
                  }}
                >
                  ${icons.settings}
                </a>
              </openclaw-tooltip>
              <openclaw-tooltip
                .content=${t("chat.docsOpensInNewTab", { label: t("common.docs") })}
              >
                <a
                  class="sidebar-footer-icon"
                  href="https://docs.openclaw.ai"
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  aria-label=${t("common.docs")}
                >
                  ${icons.book}
                </a>
              </openclaw-tooltip>
              <openclaw-tooltip
                .content=${this.canPairDevice
                  ? t("nodes.pairing.button")
                  : t("nodes.pairing.adminRequired")}
              >
                <button
                  class="sidebar-footer-icon sidebar-pair-mobile"
                  type="button"
                  aria-label=${t("nodes.pairing.button")}
                  ?disabled=${!this.canPairDevice}
                  @click=${() => this.onPairMobile?.()}
                >
                  ${icons.smartphone}
                </button>
              </openclaw-tooltip>
              <span class="sidebar-mode-switch">
                <openclaw-theme-mode-toggle .mode=${this.themeMode}></openclaw-theme-mode-toggle>
              </span>
            </div>
          </div>
        </div>
        ${this.renderCustomizeMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
