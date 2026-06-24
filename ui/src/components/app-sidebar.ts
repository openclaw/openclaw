import { consume } from "@lit/context";
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { SessionsListResult } from "../api/types.ts";
import {
  isSettingsNavigationRoute,
  navigationIconForRoute,
  type NavigationRouteId,
  SIDEBAR_SECTIONS,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-routes.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import type { ThemeMode } from "../app/theme.ts";
import "./theme-mode-toggle.ts";
import "./session-picker.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { resolveSessionNavigation, resolveSessionCreateParams } from "../lib/sessions/index.ts";
import type { RouteLocation } from "../router/types.ts";
import { icons } from "./icons.ts";

export const SESSION_NAVIGATED_EVENT = "openclaw-session-navigated";

type SidebarRecentSession = {
  key: string;
  label: string;
  meta: string;
  href: string;
  active: boolean;
  hasActiveRun: boolean;
};

const routePreloadTimers = new WeakMap<EventTarget, ReturnType<typeof setTimeout>>();

export class AppSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) collapsed = false;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) routeLocation?: RouteLocation;
  @property({ attribute: false }) navGroupsCollapsed: Record<string, boolean> = {};
  @property({ attribute: false }) recentSessionsCollapsed = false;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onToggleGroup?: (label: string) => void;
  @property({ attribute: false }) onToggleRecentSessions?: () => void;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsLoading = false;

  private stopSessionsSubscription: (() => void) | undefined;
  private stopGatewaySubscription: (() => void) | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
    this.startSubscriptions();
  }

  override disconnectedCallback() {
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    super.disconnectedCallback();
  }

  private startSubscriptions() {
    const context = this.context;
    if (!context || this.stopSessionsSubscription || this.stopGatewaySubscription) {
      return;
    }
    this.updateSessions(context.sessions.snapshot);
    this.stopSessionsSubscription = context.sessions.subscribe((snapshot) => {
      this.updateSessions(snapshot);
    });
    this.stopGatewaySubscription = context.gateway.subscribe(() => {
      this.requestUpdate();
    });
  }

  override updated() {
    this.startSubscriptions();
  }

  private readonly updateSessions = (snapshot: {
    result: SessionsListResult | null;
    loading: boolean;
  }) => {
    this.sessionsResult = snapshot.result;
    this.sessionsLoading = snapshot.loading;
  };

  private getRouteSessionKey(): string {
    if (this.activeRouteId !== "chat") {
      return "";
    }
    return (
      new URLSearchParams(this.routeLocation?.search).get("session")?.trim() ||
      this.context?.gateway.snapshot.sessionKey.trim() ||
      ""
    );
  }

  private getSessionNavigationState() {
    const context = this.context;
    const routeSessionKey = this.getRouteSessionKey();
    const navigation = resolveSessionNavigation({
      result: this.sessionsResult,
      sessionKey: routeSessionKey,
      assistantAgentId: context?.gateway.snapshot.assistantAgentId,
      hello: context?.gateway.snapshot.hello,
    });
    const recentSessions = navigation.recentSessions.map((row) => ({
      key: row.key,
      label: resolveSessionDisplayName(row.key, row),
      meta: row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a",
      href: `${pathForRoute("chat", context?.basePath ?? "")}?session=${encodeURIComponent(
        row.key,
      )}`,
      active: row.key === routeSessionKey,
      hasActiveRun: Boolean(row.hasActiveRun),
    }));
    const newSessionDisabled =
      !this.connected || this.sessionsLoading || Boolean(navigation.selectedSession?.hasActiveRun);
    return {
      routeSessionKey: navigation.currentSessionKey,
      selectedAgentId: navigation.selectedAgentId,
      defaultAgentId: navigation.defaultAgentId,
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
    const context = this.context;
    if (!context) {
      return;
    }
    context.replace("chat", {
      search: `?session=${encodeURIComponent(sessionKey)}`,
    });
    this.dispatchEvent(new Event(SESSION_NAVIGATED_EVENT, { bubbles: true, composed: true }));
  };

  private readonly createSession = async () => {
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
      ...resolveSessionCreateParams(routeSessionKey, selectedAgentId, {
        emitCommandHooksWithoutParent: false,
      }),
    });
    if (nextSessionKey) {
      this.selectSession(nextSessionKey);
    }
  };

  private preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    if (routeId === this.activeRouteId || !this.isRouteEnabled(routeId) || !this.onPreloadRoute) {
      return;
    }
    const target = event.currentTarget;
    if (!target) {
      return;
    }
    const start = () => {
      routePreloadTimers.delete(target);
      void this.onPreloadRoute?.(routeId).catch(() => undefined);
    };
    if (immediate) {
      start();
      return;
    }
    if (!routePreloadTimers.has(target)) {
      routePreloadTimers.set(target, globalThis.setTimeout(start, 50));
    }
  }

  private cancelPreload(event: Event) {
    const target = event.currentTarget;
    if (!target) {
      return;
    }
    const timer = routePreloadTimers.get(target);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      routePreloadTimers.delete(target);
    }
  }

  private isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.enabledRouteIds?.includes(routeId) ?? true;
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
        ? `${pathForRoute("chat", this.basePath)}?session=${encodeURIComponent(routeSessionKey)}`
        : pathForRoute(routeId as RouteId, this.basePath);
    return html`
      <a
        href=${href}
        class="nav-item ${active ? "nav-item--active" : ""}"
        @focus=${(event: Event) => this.preloadRoute(routeId, event)}
        @blur=${this.cancelPreload}
        @pointerenter=${(event: Event) => this.preloadRoute(routeId, event)}
        @pointerleave=${this.cancelPreload}
        @touchstart=${(event: TouchEvent) => this.preloadRoute(routeId, event, true)}
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
          this.onNavigate?.(routeId);
        }}
        title=${titleForRoute(routeId)}
      >
        <span class="nav-item__icon" aria-hidden="true"
          >${icons[navigationIconForRoute(routeId)]}</span
        >
        ${!this.collapsed
          ? html`<span class="nav-item__text">${titleForRoute(routeId)}</span>`
          : nothing}
      </a>
    `;
  }

  private renderRecentSession(session: SidebarRecentSession) {
    return html`
      <a
        href=${session.href}
        class="sidebar-recent-session ${session.active ? "sidebar-recent-session--active" : ""}"
        data-session-key=${session.key}
        title=${`${session.label} · ${session.key}`}
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
          this.selectSession(session.key);
        }}
      >
        <span class="sidebar-recent-session__dot" aria-hidden="true"></span>
        <span class="sidebar-recent-session__body">
          <span class="sidebar-recent-session__name">${session.label}</span>
          <span class="sidebar-recent-session__meta">${session.meta}</span>
        </span>
        ${session.hasActiveRun
          ? html`<span
              class="sidebar-recent-session__live"
              aria-label=${t("sessions.sessionDetails.activeRun")}
            ></span>`
          : nothing}
      </a>
    `;
  }

  private renderSessions() {
    const context = this.context;
    const {
      routeSessionKey,
      selectedAgentId,
      defaultAgentId,
      recentSessions,
      newSessionDisabled,
      newSessionTitle,
    } = this.getSessionNavigationState();
    return html`
      <section class="sidebar-sessions ${this.collapsed ? "sidebar-sessions--collapsed" : ""}">
        <button
          type="button"
          class="sidebar-new-session"
          title=${newSessionTitle}
          aria-label=${t("chat.runControls.newSession")}
          ?disabled=${newSessionDisabled}
          @click=${this.createSession}
        >
          <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
          ${this.collapsed
            ? nothing
            : html`<span class="sidebar-new-session__label"
                >${t("chat.runControls.newSession")}</span
              >`}
        </button>
        <div
          class="sidebar-session-select ${this.collapsed
            ? "sidebar-session-select--collapsed"
            : ""}"
        >
          <openclaw-session-picker
            .sessions=${context?.sessions}
            .sessionsResult=${this.sessionsResult}
            .currentSessionKey=${routeSessionKey}
            .agentId=${selectedAgentId}
            .defaultAgentId=${defaultAgentId}
            .connected=${this.connected}
            .compact=${this.collapsed}
            .onSelectSession=${this.selectSession}
          ></openclaw-session-picker>
        </div>
        ${this.collapsed || recentSessions.length === 0
          ? nothing
          : html`
              <div
                class="sidebar-recent-sessions ${this.recentSessionsCollapsed
                  ? "sidebar-recent-sessions--collapsed"
                  : ""}"
                aria-label=${t("overview.cards.recentSessions")}
              >
                <button
                  class="sidebar-recent-sessions__label"
                  type="button"
                  aria-expanded=${String(!this.recentSessionsCollapsed)}
                  @click=${() => this.onToggleRecentSessions?.()}
                >
                  <span class="sidebar-recent-sessions__label-text"
                    >${t("usage.sessions.recentShort")}</span
                  >
                  <span class="sidebar-recent-sessions__chevron"> ${icons.chevronDown} </span>
                </button>
                <div class="sidebar-recent-sessions__list">
                  ${recentSessions.map((session) => this.renderRecentSession(session))}
                </div>
              </div>
            `}
      </section>
    `;
  }

  override render() {
    return html`
      <aside class="sidebar ${this.collapsed ? "sidebar--collapsed" : ""}">
        <div class="sidebar-shell">
          <div class="sidebar-shell__header">
            <div class="sidebar-brand">
              ${this.collapsed
                ? nothing
                : html`
                    <img
                      class="sidebar-brand__logo"
                      src="${controlUiPublicAssetPath("favicon.svg", this.basePath)}"
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
              @click=${() => this.onToggleCollapsed?.()}
              title="${this.collapsed ? t("nav.expand") : t("nav.collapse")}"
              aria-label="${this.collapsed ? t("nav.expand") : t("nav.collapse")}"
            >
              <span class="nav-collapse-toggle__icon" aria-hidden="true"
                >${this.collapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
              >
            </button>
          </div>
          <div class="sidebar-shell__body">
            ${this.renderSessions()}
            <nav class="sidebar-nav">
              ${SIDEBAR_SECTIONS.map((group) => {
                const isGroupCollapsed = this.navGroupsCollapsed[group.label] ?? false;
                const showItems = this.collapsed || !isGroupCollapsed;
                return html`
                  <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
                    ${!this.collapsed
                      ? html`
                          <button
                            class="nav-section__label"
                            @click=${() => this.onToggleGroup?.(group.label)}
                            aria-expanded=${showItems}
                          >
                            <span class="nav-section__label-text">${t(`nav.${group.label}`)}</span>
                            <span class="nav-section__chevron"> ${icons.chevronDown} </span>
                          </button>
                        `
                      : nothing}
                    <div class="nav-section__items">
                      ${group.routes.map((routeId) => this.renderRoute(routeId))}
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
                ${!this.collapsed
                  ? html`
                      <span class="nav-item__text">${t("common.docs")}</span>
                      <span class="nav-item__external-icon">${icons.externalLink}</span>
                    `
                  : nothing}
              </a>
              <div class="sidebar-mode-switch">
                <openclaw-theme-mode-toggle .mode=${this.themeMode}></openclaw-theme-mode-toggle>
              </div>
              <div class="sidebar-status">
                <span
                  class="sidebar-status__dot ${this.connected
                    ? "sidebar-connection-status--online"
                    : "sidebar-connection-status--offline"}"
                  role="img"
                  aria-live="polite"
                  aria-label=${t("chat.gatewayStatus", {
                    status: this.connected ? t("common.online") : t("common.offline"),
                  })}
                  title=${t("chat.gatewayStatus", {
                    status: this.connected ? t("common.online") : t("common.offline"),
                  })}
                ></span>
                ${this.collapsed
                  ? nothing
                  : html`<span class="sidebar-status__text"
                      >${this.connected ? t("common.online") : t("common.offline")}</span
                    >`}
              </div>
            </div>
          </div>
        </div>
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
