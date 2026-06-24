import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SessionsListResult } from "../api/types.ts";
import {
  isSettingsNavigationRoute,
  navigationIconForRoute,
  type NavigationRouteId,
  SIDEBAR_SECTIONS,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-routes.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import "./theme-mode-toggle.ts";
import "./session-picker.ts";
import type { ApplicationSessions } from "../app/sessions.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { icons } from "./icons.ts";

export type SidebarRecentSession = {
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
  @property({ attribute: false }) getHref?: (routeId: NavigationRouteId) => string;
  @property({ attribute: false }) collapsed = false;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) version = "";
  @property({ attribute: false }) navGroupsCollapsed: Record<string, boolean> = {};
  @property({ attribute: false }) recentSessions: readonly SidebarRecentSession[] = [];
  @property({ attribute: false }) recentSessionsCollapsed = false;
  @property({ attribute: false }) newSessionDisabled = false;
  @property({ attribute: false }) newSessionTitle = "";
  @property({ attribute: false }) sessions?: ApplicationSessions;
  @property({ attribute: false }) sessionsResult: SessionsListResult | null = null;
  @property({ attribute: false }) currentSessionKey = "";
  @property({ attribute: false }) sessionAgentId = "main";
  @property({ attribute: false }) defaultAgentId = "main";
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) onCreateSession?: () => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onToggleGroup?: (label: string) => void;
  @property({ attribute: false }) onToggleRecentSessions?: () => void;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) onRecentSession?: (session: SidebarRecentSession) => void;
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

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
    const href = this.getHref?.(routeId) ?? pathForRoute(routeId as RouteId, this.basePath);
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
          this.onRecentSession?.(session);
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
    return html`
      <section class="sidebar-sessions ${this.collapsed ? "sidebar-sessions--collapsed" : ""}">
        <button
          type="button"
          class="sidebar-new-session"
          title=${this.newSessionTitle}
          aria-label=${t("chat.runControls.newSession")}
          ?disabled=${this.newSessionDisabled}
          @click=${() => this.onCreateSession?.()}
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
            .sessions=${this.sessions}
            .sessionsResult=${this.sessionsResult}
            .currentSessionKey=${this.currentSessionKey}
            .agentId=${this.sessionAgentId}
            .defaultAgentId=${this.defaultAgentId}
            .connected=${this.connected}
            .compact=${this.collapsed}
            .onSelectSession=${this.onSelectSession}
          ></openclaw-session-picker>
        </div>
        ${this.collapsed || this.recentSessions.length === 0
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
                  ${this.recentSessions.map((session) => this.renderRecentSession(session))}
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
              ${this.version
                ? html`
                    <div class="sidebar-version" title=${`v${this.version}`}>
                      ${!this.collapsed
                        ? html`
                            <span class="sidebar-version__label">${t("common.version")}</span>
                            <span class="sidebar-version__text">v${this.version}</span>
                            <span
                              class="sidebar-version__status ${this.connected
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
                          `
                        : html`
                            <span
                              class="sidebar-version__status ${this.connected
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
                          `}
                    </div>
                  `
                : nothing}
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
