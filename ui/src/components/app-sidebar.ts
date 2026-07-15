import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import { channelDisplayLabel } from "../lib/session-display.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { writeSessionDragData, writeSessionGroupDragData } from "../lib/sessions/drag.ts";
import { groupSidebarSessionRows } from "../lib/sessions/grouping.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-chip.ts";
import "./sidebar-attention.ts";
import "./sidebar-build-chip.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { AppSidebarMenusElement } from "./app-sidebar-menus.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import {
  type CatalogBackingSessionDisplay,
  renderSessionCatalogGroups,
} from "./app-sidebar-session-catalogs.ts";
import {
  limitSidebarSessionRows,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  LOBSTER_LOGO_VISIT_EVENT,
  LOBSTER_PET_BUILD_MULS,
  LOBSTER_PET_CLAW_MULS,
  lobsterPetSeed,
  renderLobsterSvg,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterLogoVisitDetail,
} from "./lobster-pet.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";

const PALETTE_SHORTCUT = /Mac|iP(hone|ad|od)/i.test(globalThis.navigator?.platform ?? "")
  ? "⌘K"
  : "Ctrl K";

class AppSidebar extends AppSidebarMenusElement {
  @state() private logoVisit: LobsterLogoVisitDetail | null = null;

  constructor() {
    super();
    // The footer pet announces logo stand-in phases through this bubbling event.
    this.addEventListener(LOBSTER_LOGO_VISIT_EVENT, this.handleLogoVisit as EventListener);
  }

  private readonly handleLogoVisit = (event: Event) => {
    const detail = (event as CustomEvent<LobsterLogoVisitDetail>).detail;
    this.logoVisit = detail.phase === "out" || !detail.look ? null : detail;
  };

  private renderLogoStandIn() {
    const visit = this.logoVisit;
    if (!visit?.look) {
      return nothing;
    }
    const look = visit.look;
    const classes = [
      "sidebar-brand__pet",
      `lobster-pet--palette-${look.palette.id}`,
      visit.phase === "leaving" ? "sidebar-brand__pet--leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = [
      `--lob-shell:${look.palette.shell}`,
      `--lob-claw:${look.palette.claw}`,
      `--lob-blink-delay:${look.blinkDelayS}s`,
      `--lob-w:${LOBSTER_PET_BUILD_MULS[look.build].w}`,
      `--lob-h:${LOBSTER_PET_BUILD_MULS[look.build].h}`,
      `--lob-claw-scale:${LOBSTER_PET_CLAW_MULS[look.clawSize]}`,
    ].join(";");
    return html`
      <span class=${classes} style=${style} title=${`${visit.name} · filling in for the logo`}
        >${renderLobsterSvg(look)}</span
      >
    `;
  }

  private renderBrand() {
    const collapseLabel = t("nav.collapse");
    return html`
      <div class="sidebar-brand">
        <a
          class="sidebar-brand__identity"
          href=${pathForRoute("new-session", this.basePath)}
          aria-label=${titleForRoute("new-session")}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("new-session");
          }}
        >
          <span class="sidebar-brand__logo-slot">
            <img
              class="sidebar-brand__logo ${this.logoVisit ? "sidebar-brand__logo--vacated" : ""}"
              src=${controlUiPublicAssetPath("apple-touch-icon.png", this.basePath)}
              alt=""
              aria-hidden="true"
            />
            ${this.renderLogoStandIn()}
          </span>
          <span class="sidebar-brand__title">OpenClaw</span>
        </a>
        <div class="sidebar-brand__actions">
          ${this.renderSearch()}
          <openclaw-tooltip .content=${`${collapseLabel} (⌘B)`}>
            <button
              class="sidebar-brand__icon sidebar-brand__collapse"
              type="button"
              @click=${() => this.onToggleSidebar?.()}
              aria-label=${collapseLabel}
              aria-expanded="true"
            >
              ${icons.panelLeftClose}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    `;
  }

  private renderSearch() {
    const tooltip = `${t("chat.openCommandPalette")} (${PALETTE_SHORTCUT})`;
    return html`
      <openclaw-tooltip .content=${tooltip}>
        <button
          type="button"
          class="sidebar-brand__icon sidebar-search"
          ?disabled=${!this.onOpenPalette}
          aria-label=${t("chat.openCommandPalette")}
          @click=${() => this.onOpenPalette?.()}
        >
          ${icons.search}
        </button>
      </openclaw-tooltip>
    `;
  }

  private renderRecentSession(
    session: SidebarRecentSession,
    display?: CatalogBackingSessionDisplay,
  ) {
    const label = display?.label ?? session.label;
    const subtitle = display
      ? display.subtitle
      : session.subtitle && session.workSession && session.subtitle !== session.label
        ? session.subtitle
        : undefined;
    const meta = display?.meta ?? session.meta;
    const rowClass = [
      "sidebar-recent-session",
      "session-row-host",
      session.visuallyActive ? "sidebar-recent-session--active" : "",
      this.selectedSessionKeys.has(session.key) ? "sidebar-recent-session--selected" : "",
      session.pinned ? "session-row-host--pinned" : "",
      session.hasActiveRun ? "session-row-host--running" : "",
      this.draggingSessionKey === session.key ? "sidebar-recent-session--dragging" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const row = html`
      <div
        class=${rowClass}
        data-session-key=${session.key}
        draggable="true"
        @dragstart=${(event: DragEvent) => {
          if (event.dataTransfer) {
            writeSessionDragData(event.dataTransfer, session.key);
            this.draggingSessionKey = session.key;
          }
        }}
        @dragend=${() => {
          this.draggingSessionKey = null;
          this.sessionDropTarget = null;
        }}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault();
          this.openSessionMenuForRow(session, event.clientX, event.clientY);
        }}
        @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
        @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
      >
        <a
          href=${session.href}
          class="sidebar-recent-session__link"
          draggable="false"
          title=${display?.title ?? `${session.label} · ${session.key}`}
          @click=${(event: MouseEvent) => this.handleSessionRowClick(event, session)}
        >
          ${session.hasActiveRun
            ? html`<span
                class="session-run-spinner sidebar-recent-session__state"
                role="img"
                aria-label=${t("sessionsView.activeRun")}
                title=${t("sessionsView.activeRun")}
              ></span>`
            : session.unread
              ? html`<span
                  class="session-unread-dot sidebar-recent-session__unread"
                  role="img"
                  aria-label=${t("sessionsView.unread")}
                ></span>`
              : nothing}
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name hover-marquee">${label}</span>
            ${subtitle
              ? html`<span class="sidebar-recent-session__subtitle">${subtitle}</span>`
              : nothing}
          </span>
          ${renderSessionRowBadges(session)}
        </a>
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail">${meta}</span>
          <span class="session-row-actions">
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
            <button
              class="session-action"
              data-session-menu="true"
              type="button"
              title=${t("chat.sidebar.openSessionMenu")}
              aria-label=${t("chat.sidebar.openSessionMenu")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionMenu?.session.key === session.key)}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                if (this.sessionMenu?.session.key === session.key) {
                  this.closeSessionMenu();
                  return;
                }
                const trigger = event.currentTarget as HTMLElement;
                const rect = trigger.getBoundingClientRect();
                this.openSessionMenuForRow(session, rect.right, rect.bottom + 4, trigger);
              }}
            >
              ${icons.moreHorizontal}
            </button>
          </span>
        </span>
      </div>
    `;
    // Marquee state mutates the row DOM; keying prevents cross-session reuse.
    return keyed(session.key, row);
  }

  private renderSessionSection(
    section: {
      id: string;
      category?: string;
      channel?: string;
      work?: boolean;
      rows: SidebarRecentSession[];
    },
    showFallback = false,
  ) {
    const group = section.category;
    const isPinned = section.id === "pinned";
    const showHeader = isPinned || this.sessionsGrouping === "category";
    const collapsed = showHeader && this.collapsedSessionSections.has(section.id);
    const label = isPinned
      ? t("sessionsView.pinned")
      : section.channel
        ? channelDisplayLabel(section.channel)
        : section.work
          ? t("chat.sidebar.workSessions")
          : group
            ? group
            : t("chat.sidebar.chats");
    const acceptsSessions =
      isPinned ||
      (this.sessionsGrouping === "category" && (section.id === "ungrouped" || Boolean(group)));
    const sectionClass = [
      "sidebar-recent-sessions__group",
      collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
      group && this.draggingSessionGroup === group
        ? "sidebar-recent-sessions__group--dragging"
        : "",
      this.sessionDropTarget === section.id ? "sidebar-recent-sessions__group--session-drop" : "",
      group && this.sessionGroupDropTarget?.group === group
        ? `sidebar-recent-sessions__group--group-drop-${this.sessionGroupDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div
        class=${sectionClass}
        data-session-section=${section.id}
        @dragover=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragOver(event, section.id, group)
          : nothing}
        @dragleave=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDragLeave(event, section.id, group)
          : nothing}
        @drop=${acceptsSessions || group
          ? (event: DragEvent) => this.handleSessionSectionDrop(event, section.id, group)
          : nothing}
      >
        ${showHeader
          ? html`
              <div
                class="sidebar-recent-sessions__head ${group
                  ? "sidebar-recent-sessions__head--draggable"
                  : ""}"
                draggable=${group ? "true" : "false"}
                @dragstart=${group
                  ? (event: DragEvent) => {
                      if (event.dataTransfer) {
                        writeSessionGroupDragData(event.dataTransfer, group);
                        this.draggingSessionGroup = group;
                      }
                    }
                  : nothing}
                @dragend=${group
                  ? () => {
                      this.draggingSessionGroup = null;
                      this.sessionGroupDropTarget = null;
                    }
                  : nothing}
                @contextmenu=${group
                  ? (event: MouseEvent) => {
                      event.preventDefault();
                      this.openSessionGroupMenu(group, event.clientX, event.clientY, null);
                    }
                  : nothing}
              >
                ${group
                  ? html`<span class="sidebar-session-group-drag-handle" aria-hidden="true"></span>`
                  : nothing}
                <button
                  type="button"
                  class="sidebar-session-group-toggle"
                  aria-expanded=${String(!collapsed)}
                  aria-label=${label}
                  @click=${() => this.toggleSessionSection(section.id)}
                >
                  <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
                    >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                  >
                  <span class="sidebar-recent-sessions__label-text">${label}</span>
                  <span class="sidebar-session-group-count">${section.rows.length}</span>
                </button>
                ${group
                  ? html`
                      <button
                        type="button"
                        class="sidebar-session-group-actions"
                        title=${t("sessionsView.groupMenu", { group })}
                        aria-label=${t("sessionsView.groupMenu", { group })}
                        aria-haspopup="menu"
                        aria-expanded=${String(this.sessionGroupMenu?.group === group)}
                        @click=${(event: MouseEvent) => {
                          event.stopPropagation();
                          const trigger = event.currentTarget as HTMLElement;
                          const rect = trigger.getBoundingClientRect();
                          this.openSessionGroupMenu(group, rect.right, rect.bottom + 4, trigger);
                        }}
                      >
                        ${icons.moreHorizontal}
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${collapsed
          ? nothing
          : html`
              <div class="sidebar-recent-sessions__list">
                ${showFallback
                  ? this.renderChatFallback()
                  : section.rows.map((session) => this.renderRecentSession(session))}
              </div>
            `}
      </div>
    `;
  }

  private renderDraftSessionRow() {
    return html`
      <div class="sidebar-recent-session sidebar-recent-session--draft">
        <span class="sidebar-recent-session__link">
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__name">${t("newSession.draftRow")}</span>
          </span>
        </span>
      </div>
    `;
  }

  private renderSessionListBody(
    rows: SidebarRecentSession[],
    options: { showDraft: boolean; showFallback: boolean },
  ) {
    const visibleRows = limitSidebarSessionRows(rows, this.visibleSessionLimit);
    const sections = groupSidebarSessionRows(visibleRows, {
      grouping: this.sessionsGrouping,
      knownGroups: this.sessionsGrouping === "category" ? this.knownSessionGroups() : undefined,
    });
    return html`
      ${options.showDraft ? this.renderDraftSessionRow() : nothing}
      ${sections.map((section) =>
        this.renderSessionSection(
          section,
          options.showFallback && rows.length === 0 && section.id === "ungrouped",
        ),
      )}
      ${this.renderSessionPagination(rows, visibleRows.length)}
    `;
  }

  private renderSessionPagination(rows: SidebarRecentSession[], visible: number) {
    const canShowMore = visible < rows.length;
    const collapsedVisible = limitSidebarSessionRows(rows, SIDEBAR_SESSION_PAGE_SIZE).length;
    const canShowLess = visible > SIDEBAR_SESSION_SEE_LESS_THRESHOLD && visible > collapsedVisible;
    if (!canShowMore && !canShowLess) {
      return nothing;
    }
    return html`
      <div class="sidebar-session-pagination">
        ${canShowMore
          ? html`<button
              type="button"
              class="sidebar-session-pagination__button"
              aria-label=${t("chat.selectors.loadMoreSessions")}
              @click=${() => {
                this.visibleSessionLimit = visible + SIDEBAR_SESSION_PAGE_SIZE;
              }}
            >
              ${t("chat.selectors.loadMoreSessions")}
            </button>`
          : nothing}
        ${canShowLess
          ? html`<button
              type="button"
              class="sidebar-session-pagination__button"
              aria-label=${t("usage.details.collapse")}
              @click=${() => {
                this.clearSessionSelection();
                this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
              }}
            >
              ${t("usage.details.collapse")}
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    return html`
      <section class="sidebar-sessions">
        ${this.sessionMutationError
          ? html`
              <div
                class="sidebar-session-error callout danger callout--dismissible"
                role="alert"
                data-sidebar-session-error
              >
                <span class="callout__content">${this.sessionMutationError}</span>
                <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                  <button
                    class="callout__dismiss"
                    type="button"
                    @click=${() => {
                      this.sessionMutationError = null;
                    }}
                    aria-label=${t("chat.actions.dismissError")}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
              </div>
            `
          : nothing}
        <div
          class="sidebar-recent-sessions sidebar-recent-sessions--scroll-${this
            .sessionsScrollState}"
          aria-label=${titleForRoute("sessions")}
          @scroll=${(event: Event) =>
            this.updateSessionsScrollState(event.currentTarget as HTMLElement)}
        >
          <div class="sidebar-recent-sessions__head sidebar-recent-sessions__head--root">
            <span class="sidebar-recent-sessions__label-text">${t("sessionsView.title")}</span>
            <button
              type="button"
              class="sidebar-session-sort"
              title=${t("chat.sidebar.sortSessions")}
              aria-label=${t("chat.sidebar.sortSessions")}
              aria-haspopup="menu"
              aria-expanded=${String(this.sessionSortMenuPosition !== null)}
              @click=${(event: MouseEvent) =>
                this.toggleSessionSortMenu(event.currentTarget as HTMLElement)}
            >
              ${icons.listFilter}
            </button>
            <button
              type="button"
              class="sidebar-session-sort sidebar-session-new"
              title=${navigationState.newSessionTitle}
              aria-label=${t("chat.runControls.newSession")}
              ?disabled=${navigationState.newSessionDisabled}
              @click=${() => this.onOpenNewSession?.(expandedAgentId)}
            >
              ${icons.plus}
            </button>
          </div>
          ${this.renderSessionListBody(visibleSessions, {
            showDraft:
              Boolean(this.draftSessionAgentId) &&
              normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
            showFallback: true,
          })}
          ${this.renderSessionCatalogs(navigationState)}
        </div>
      </section>
    `;
  }

  private renderSessionCatalogs(
    navigationState: ReturnType<AppSidebar["getSessionNavigationState"]>,
  ) {
    return renderSessionCatalogGroups({
      catalogs: this.sessionCatalogs,
      connected: this.connected,
      basePath: this.basePath,
      routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
      newSessionAgentId: this.expandedAgentId(),
      collapsedSections: this.collapsedSessionSections,
      loadingMoreCatalogIds: this.loadingMoreSessionCatalogIds,
      liveRows: [
        ...(this.sessionsResult?.sessions ?? []),
        ...Object.values(this.sessionRowsByAgent).flat(),
      ],
      renderLiveRow: (row, display) =>
        this.renderRecentSession(navigationState.toSidebarSession(row), display),
      onToggleSection: (sectionId) => this.toggleSessionSection(sectionId),
      onLoadMore: (catalogId) => void this.loadMoreSessionCatalog(catalogId),
      onOpenNewSession: this.onOpenNewSession,
      onNavigate: this.onNavigate,
      catalogOpenTarget: this.catalogOpenTarget,
      terminalAvailable: this.terminalAvailable,
      onOpenTerminal: (key) => openCatalogSessionInTerminal(key),
      onOpenMenu: (request, x, y, trigger) => this.catalogMenu.open(request, x, y, trigger),
    });
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
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name">${t("nav.chat")}</span>
        </span>
      </a>
    `;
  }

  override render() {
    const gatewayStatus = t("chat.gatewayStatus", {
      status: this.connected ? t("common.online") : t("common.offline"),
    });
    const { activeId: chipAgentId, agent: chipAgent, agents: chipAgents } = this.activeChipAgent();
    const chipMenuUnread = chipAgents.some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== chipAgentId && this.agentUnreadCount(agentId) > 0;
    });
    const chipName = chipAgent ? normalizeAgentLabel(chipAgent) : chipAgentId;
    const chipAvatarText =
      (chipAgent ? resolveAgentTextAvatar(chipAgent) : null) ??
      (chipName || chipAgentId).slice(0, 1).toUpperCase();
    return html`
      <aside class="sidebar">
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${this.renderBrand()}
          <div class="sidebar-shell__body">
            <nav class="sidebar-nav" @contextmenu=${this.openCustomizeMenuFromContext}>
              <div class="nav-section__items">
                ${this.sidebarPinnedRoutes.map((routeId) => this.renderRoute(routeId))}
                ${this.renderMoreRow()}
              </div>
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            <openclaw-sidebar-attention
              .onNavigate=${(routeId: NavigationRouteId) => this.onNavigate?.(routeId)}
            ></openclaw-sidebar-attention>
            <openclaw-sidebar-update-card
              .updateAvailable=${this.updateAvailable}
              .updateRunning=${this.updateRunning}
              .onUpdate=${this.onUpdate}
            ></openclaw-sidebar-update-card>
            <openclaw-lobster-pet
              .seed=${lobsterPetSeed(this.sessionKey)}
              .mode=${resolveLobsterPetMode(this.connected, this.sessionsResult?.sessions)}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
              .soundsEnabled=${this.lobsterPetSounds}
              .gatewayVersion=${this.gatewayVersion}
            ></openclaw-lobster-pet>
            ${this.devGitBranch
              ? html`<div class="sidebar-footer-branch" title=${this.devGitBranch}>
                  <span class="sidebar-footer-branch__icon" aria-hidden="true"
                    >${icons.gitBranch}</span
                  >
                  <span class="sidebar-footer-branch__name">${this.devGitBranch}</span>
                </div>`
              : nothing}
            <openclaw-sidebar-agent-chip
              .agentName=${chipName}
              .avatarUrl=${chipAgent ? resolveAgentAvatarUrl(chipAgent) : null}
              .avatarText=${chipAvatarText}
              .connected=${this.connected}
              .statusLabel=${gatewayStatus}
              .subtitle=${this.agentChipSubtitle(chipAgentId)}
              .menuOpen=${this.agentMenuPosition !== null}
              .menuUnread=${chipMenuUnread}
              .newSessionDisabled=${!this.connected}
              .onNewSession=${() => this.onOpenNewSession?.(chipAgentId)}
              .onToggleMenu=${(trigger: HTMLElement) => this.toggleAgentMenu(trigger)}
            ></openclaw-sidebar-agent-chip>
          </div>
        </div>
        ${this.renderCustomizeMenu()} ${this.renderMoreMenu()} ${this.renderAgentMenu()}
        ${this.renderSessionMenu()} ${this.catalogMenu.render()} ${this.renderSessionGroupMenu()}
        ${this.renderSessionSortMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
