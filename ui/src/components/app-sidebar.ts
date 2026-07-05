import { consume } from "@lit/context";
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import {
  cancelRoutePreload,
  isSettingsNavigationRoute,
  navigationIconForRoute,
  scheduleRoutePreload,
  type NavigationRouteId,
  SIDEBAR_SECTIONS,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "../app/context.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import "./theme-mode-toggle.ts";
import "./session-picker.ts";
import "./tooltip.ts";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  compareSessionRowsByUpdatedAt,
  resolveSessionNavigation,
  searchForSession,
} from "../lib/sessions/index.ts";
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
import { icons } from "./icons.ts";

type SidebarRecentSession = {
  key: string;
  label: string;
  meta: string;
  href: string;
  active: boolean;
  hasActiveRun: boolean;
  kind?: string;
  pinned: boolean;
  pinnedAt?: number | null;
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
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) collapsed = false;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) navGroupsCollapsed: Record<string, boolean> = {};
  @property({ attribute: false }) recentSessionsCollapsed = false;
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onToggleGroup?: (label: string) => void;
  @property({ attribute: false }) onToggleRecentSessions?: () => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext<RouteId>;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private sessionsAgentId: string | null = null;
  @state() private sessionsLoading = false;

  private stopSessionsSubscription: (() => void) | undefined;
  private stopAgentsSubscription: (() => void) | undefined;
  private stopAgentSelectionSubscription: (() => void) | undefined;
  private stopGatewaySubscription: (() => void) | undefined;
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
      pinnedAt: row.pinnedAt,
    });
    const activeSession = navigation.selectedSession
      ? toSidebarSession(navigation.selectedSession)
      : null;
    const recentSessions = navigation.recentSessions
      .slice(activeSession ? 1 : 0)
      .toSorted(compareSessionRowsByUpdatedAt)
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
      currentSessionKey: routeSessionKey,
      agentId: selectedAgentId,
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
    const newSessionButton = html`
      <button
        type="button"
        class="sidebar-new-session"
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
    `;
    return html`
      <section class="sidebar-sessions ${this.collapsed ? "sidebar-sessions--collapsed" : ""}">
        ${this.collapsed
          ? html`<openclaw-tooltip .content=${newSessionTitle}
              >${newSessionButton}</openclaw-tooltip
            >`
          : newSessionButton}
        ${this.collapsed
          ? nothing
          : html`
              <div
                class="sidebar-recent-sessions ${this.recentSessionsCollapsed
                  ? "sidebar-recent-sessions--collapsed"
                  : ""}"
                aria-label=${t("overview.cards.recentSessions")}
              >
                <div class="sidebar-recent-sessions__head">
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
                ${activeSession
                  ? this.renderRecentSession(activeSession)
                  : this.renderChatFallback()}
                ${recentSessions.length === 0
                  ? nothing
                  : html`
                      <div class="sidebar-recent-sessions__list">
                        ${recentSessions.map((session) => this.renderRecentSession(session))}
                      </div>
                    `}
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
                      <span class="sidebar-brand__title">OpenClaw</span>
                    </span>
                  `}
            </div>
            <openclaw-tooltip .content=${this.collapsed ? t("nav.expand") : t("nav.collapse")}>
              <button
                type="button"
                class="nav-collapse-toggle"
                @click=${() => this.onToggleCollapsed?.()}
                aria-label=${this.collapsed ? t("nav.expand") : t("nav.collapse")}
              >
                <span class="nav-collapse-toggle__icon" aria-hidden="true"
                  >${this.collapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
                >
              </button>
            </openclaw-tooltip>
          </div>
          <div class="sidebar-shell__body">
            ${this.renderSessions()}
            <nav class="sidebar-nav">
              ${SIDEBAR_SECTIONS.filter((group) => this.collapsed || group.label !== "chat").map(
                (group) => {
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
                              <span class="nav-section__label-text"
                                >${t(`nav.${group.label}`)}</span
                              >
                              <span class="nav-section__chevron"> ${icons.chevronDown} </span>
                            </button>
                          `
                        : nothing}
                      <div class="nav-section__items">
                        ${group.routes.map((routeId) => this.renderRoute(routeId))}
                      </div>
                    </section>
                  `;
                },
              )}
            </nav>
          </div>
          <div class="sidebar-shell__footer">
            <div class="sidebar-utility-group">
              ${this.collapsed
                ? html`
                    <openclaw-tooltip
                      .content=${t("chat.docsOpensInNewTab", { label: t("common.docs") })}
                    >
                      <a
                        class="nav-item nav-item--external sidebar-utility-link"
                        href="https://docs.openclaw.ai"
                        target=${EXTERNAL_LINK_TARGET}
                        rel=${buildExternalLinkRel()}
                      >
                        <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
                      </a>
                    </openclaw-tooltip>
                  `
                : html`
                    <a
                      class="nav-item nav-item--external sidebar-utility-link"
                      href="https://docs.openclaw.ai"
                      target=${EXTERNAL_LINK_TARGET}
                      rel=${buildExternalLinkRel()}
                    >
                      <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
                      <span class="nav-item__text">${t("common.docs")}</span>
                      <span class="nav-item__external-icon">${icons.externalLink}</span>
                    </a>
                  `}
              <div class="sidebar-mode-switch">
                <openclaw-theme-mode-toggle .mode=${this.themeMode}></openclaw-theme-mode-toggle>
              </div>
              <div class="sidebar-footer-row">
                <div class="sidebar-status">
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
                  ${this.collapsed
                    ? nothing
                    : html`<span class="sidebar-status__text"
                        >${this.connected ? t("common.online") : t("common.offline")}</span
                      >`}
                </div>
                <openclaw-tooltip
                  .content=${this.canPairDevice
                    ? t("nodes.pairing.button")
                    : t("nodes.pairing.adminRequired")}
                >
                  <button
                    class="sidebar-pair-mobile"
                    type="button"
                    aria-label=${t("nodes.pairing.button")}
                    ?disabled=${!this.canPairDevice}
                    @click=${() => this.onPairMobile?.()}
                  >
                    <span aria-hidden="true">${icons.smartphone}</span>
                  </button>
                </openclaw-tooltip>
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
