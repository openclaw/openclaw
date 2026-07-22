import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApprovalBadgeSnapshot } from "../app/approval-presentation.ts";
import { sessionHasPendingApproval } from "../app/approval-presentation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { sessionHasBoard } from "../lib/board/provider.ts";
import { formatDurationCompact } from "../lib/format.ts";
import { startHoverMarquee, stopHoverMarquee } from "../lib/hover-marquee.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type {
  CatalogBackingSessionDisplay,
  CatalogSessionMenuRequest,
} from "./app-sidebar-session-catalogs.ts";
import {
  rowDemandsVisibility,
  sidebarSessionMetaId,
  type SidebarRecentSession,
  type SidebarSessionGroupDropTarget,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderSessionLeadingState } from "./session-leading-indicator.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import type { SessionCreatedBy } from "./session-owner-chip.ts";
import { renderSessionOwnerChip } from "./session-owner-chip.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import {
  renderSidebarSessionSubtitle,
  resolveSidebarSessionSubtitle,
} from "./session-row-subtitle.ts";
import "./elapsed-time.ts";

const SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT = 4;

export type SessionListRenderContext = {
  data: {
    sidebarLiveActivity: boolean;
    narrationLines: ReadonlyMap<string, string>;
    observerDigests: ReadonlyMap<string, SessionObserverDigest>;
    pullRequestStates: ReadonlyMap<string, SessionPullRequestIndicatorState>;
    approvalBadges: ApprovalBadgeSnapshot;
    selectedSessionKeys: ReadonlySet<string>;
    draggingSessionKey: string | null;
    connected: boolean;
    presencePayload: unknown;
    presenceInstanceId: string | undefined;
    expandedSessionKeys: ReadonlySet<string>;
    fullyShownChildSessionKeys: ReadonlySet<string>;
    sessionsGrouping: SidebarSessionsGrouping;
    collapsedSessionSections: ReadonlySet<string>;
    draggingSessionGroup: string | null;
    sessionDropTarget: string | null;
    sessionGroupDropTarget: SidebarSessionGroupDropTarget | null;
    sessionSortMenuOpen: boolean;
    sessionMenuKey: string | null;
    sessionGroupMenuGroup: string | null;
    sessionsStatusFilter: SidebarSessionStatusFilter;
    sessionListRemovalDrop: boolean;
    sessionMutationError: string | null;
    sessionOwnershipVisible: boolean;
    sessionCreatorOptions: readonly SessionCreatedBy[];
    sessionCreatorFilterId: string | null;
  };
  callbacks: {
    startSessionDrag: (session: SidebarRecentSession) => void;
    finishSessionDrag: () => void;
    openSessionMenuAt: (
      session: SidebarRecentSession,
      x: number,
      y: number,
      trigger?: HTMLElement,
    ) => void;
    handleSessionRowClick: (event: MouseEvent, session: SidebarRecentSession) => void;
    toggleSessionChildren: (session: SidebarRecentSession) => void;
    pinSession: (session: SidebarRecentSession) => void;
    toggleSessionMenu: (
      session: SidebarRecentSession,
      menuSession: SidebarRecentSession,
      trigger: HTMLElement,
    ) => void;
    showAllSessionChildren: (sessionKey: string) => void;
    handleSessionSectionDragOver: (event: DragEvent, sectionId: string, group?: string) => void;
    handleSessionSectionDragLeave: (event: DragEvent, sectionId: string, group?: string) => void;
    handleSessionSectionDrop: (event: DragEvent, sectionId: string, group?: string) => void;
    startSessionGroupDrag: (group: string) => void;
    finishSessionGroupDrag: () => void;
    openSessionGroupMenu: (
      group: string,
      x: number,
      y: number,
      trigger: HTMLElement | null,
    ) => void;
    toggleSessionSection: (sectionId: string) => void;
    toggleSessionSortMenu: (trigger: HTMLElement) => void;
    openNewSessionForExpandedAgent: () => void;
    setVisibleSessionLimit: (limit: number) => void;
    clearSessionSelection: () => void;
    handleSessionListDragOver: (event: DragEvent) => void;
    handleSessionListDragLeave: (event: DragEvent) => void;
    handleSessionListDrop: (event: DragEvent) => void;
    dismissSessionMutationError: () => void;
    changeSessionCreatorFilter: (creatorId: string | null) => void;
    toggleCatalogProjectGrouping: () => void;
    loadMoreSessionCatalog: (catalogId: string) => void;
    onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
    onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
    openCatalogSessionMenu: (
      request: CatalogSessionMenuRequest,
      x: number,
      y: number,
      trigger?: HTMLElement,
    ) => void;
    openCatalogSessionInTerminal: (key: CatalogSessionKey) => void;
  };
};

export function visibleSessionChildren(params: {
  session: SidebarRecentSession;
  fullyShownChildSessionKeys: ReadonlySet<string>;
}): readonly SidebarRecentSession[] {
  const showAllChildren = params.fullyShownChildSessionKeys.has(params.session.key);
  // Active, running, and attention-bearing branches must bypass the quiet-child cap.
  return showAllChildren
    ? params.session.children
    : params.session.children.filter(
        (child, index) =>
          index < SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT || rowDemandsVisibility(child),
      );
}

function renderRecentSession(params: {
  context: SessionListRenderContext;
  session: SidebarRecentSession;
  display?: CatalogBackingSessionDisplay;
}) {
  const { context, session, display } = params;
  const { data, callbacks } = context;
  const label = display?.label ?? session.label;
  const { subtitle, narration } = resolveSidebarSessionSubtitle({
    session,
    hasDisplay: display !== undefined,
    displaySubtitle: display?.subtitle,
    sidebarLiveActivity: data.sidebarLiveActivity,
    narrationLine: data.narrationLines.get(session.key),
    observerDigest: data.observerDigests.get(session.key) ?? null,
  });
  const { running, pinnedState, leadingIndicator } = renderSessionLeadingState(
    session,
    data.pullRequestStates.get(session.key) ?? "none",
  );
  const meta = display?.meta ?? session.meta;
  const rowMeta = session.pinned ? "" : meta;
  const hasTrail = session.isChild && (session.runtimeMs != null || session.startedAt != null);
  const metaId = hasTrail ? sidebarSessionMetaId(session.key) : undefined;
  const menuSession = display ? { ...session, meta } : session;
  const title = display?.title ?? [label, narration, rowMeta].filter(Boolean).join(" · ");
  const rowClass = [
    "sidebar-recent-session",
    "session-row-host",
    session.isChild ? "sidebar-recent-session--child" : "",
    session.archived ? "sidebar-session--archived" : "",
    session.visuallyActive ? "sidebar-recent-session--active" : "",
    data.selectedSessionKeys.has(session.key) ? "sidebar-recent-session--selected" : "",
    session.pinned ? "session-row-host--pinned" : "",
    running ? "session-row-host--running" : "",
    session.attention.kind === "error"
      ? "sidebar-recent-session--attention-danger"
      : session.attention.kind !== "none"
        ? "sidebar-recent-session--attention-amber"
        : "",
    data.draggingSessionKey === session.key ? "sidebar-recent-session--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const childrenExpanded = data.expandedSessionKeys.has(session.key);
  const row = html`
    <div
      class=${rowClass}
      data-session-key=${session.key}
      role="listitem"
      draggable=${session.isChild ? "false" : "true"}
      @dragstart=${session.isChild
        ? nothing
        : (event: DragEvent) => {
            if (event.dataTransfer) {
              writeSessionDragData(event.dataTransfer, session.key);
              callbacks.startSessionDrag(session);
            }
          }}
      @dragend=${session.isChild
        ? nothing
        : () => {
            callbacks.finishSessionDrag();
          }}
      @contextmenu=${session.isChild
        ? nothing
        : (event: MouseEvent) => {
            event.preventDefault();
            callbacks.openSessionMenuAt(menuSession, event.clientX, event.clientY);
          }}
      @mouseenter=${(event: MouseEvent) => startHoverMarquee(event.currentTarget as HTMLElement)}
      @mouseleave=${(event: MouseEvent) => stopHoverMarquee(event.currentTarget as HTMLElement)}
    >
      <a
        href=${session.href}
        class="sidebar-recent-session__link"
        draggable="false"
        title=${title}
        aria-current=${session.visuallyActive ? "page" : nothing}
        aria-describedby=${metaId ?? nothing}
        @click=${(event: MouseEvent) => callbacks.handleSessionRowClick(event, session)}
      >
        <span class="sidebar-session-indicator">${leadingIndicator}</span>${renderSessionOwnerChip(
          data.sessionOwnershipVisible ? session.createdBy : undefined,
          "row",
        )}
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name hover-marquee"
            >${session.archived
              ? html`<span
                  class="sidebar-session__archive-glyph"
                  aria-label=${t("sessionsView.archived")}
                  title=${t("sessionsView.archived")}
                  >${icons.archive}</span
                >`
              : nothing}${label}</span
          >
          ${renderSidebarSessionSubtitle({ subtitle, narration })}
        </span>
        ${!session.isChild && sessionHasBoard(session.key)
          ? html`<span
              class="sidebar-board-glyph"
              role="img"
              aria-label=${t("sessionsView.dashboardAvailable")}
              title=${t("sessionsView.dashboardAvailable")}
              >${icons.layoutDashboard}</span
            >`
          : nothing}
        <openclaw-viewer-facepile
          .presencePayload=${data.presencePayload}
          .selfInstanceId=${data.presenceInstanceId}
          .sessionKey=${session.key}
          .maxVisible=${3}
          variant="session"
        ></openclaw-viewer-facepile>
        ${renderSessionRowBadges({
          ...session,
          pullRequest: session.pullRequest ?? display?.pullRequest,
          hasApproval: sessionHasPendingApproval(data.approvalBadges, session.key),
        })}
        ${pinnedState}
      </a>
      ${session.childSessionKeys.length > 0
        ? html`<button
            class="sidebar-child-session-toggle ${session.runningChildCount > 0
              ? "sidebar-child-session-toggle--running"
              : session.failedChildCount > 0
                ? "sidebar-child-session-toggle--failed"
                : ""}"
            type="button"
            data-child-session-toggle=${session.key}
            aria-expanded=${String(childrenExpanded)}
            aria-label=${t(
              childrenExpanded
                ? "sessionsView.hideChildSessions"
                : "sessionsView.showChildSessions",
              { count: String(session.childSessionKeys.length), session: label },
            )}
            @click=${() => callbacks.toggleSessionChildren(session)}
          >
            <span class="sidebar-child-session-toggle__icon" aria-hidden="true"
              >${childrenExpanded ? icons.chevronDown : icons.chevronRight}</span
            >
            ${childrenExpanded
              ? nothing
              : html`<span class="sidebar-child-session-toggle__count"
                  >${session.childSessionKeys.length}</span
                >`}
          </button>`
        : nothing}
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-trail" id=${metaId ?? nothing}
          >${session.isChild && session.runtimeMs != null
            ? session.hasActiveRun || session.status === "running"
              ? html`<openclaw-elapsed-time
                  .startMs=${session.runtimeSampledAt! - session.runtimeMs}
                ></openclaw-elapsed-time>`
              : (formatDurationCompact(session.runtimeMs, { spaced: true }) ?? "0ms")
            : session.isChild && session.startedAt != null
              ? html`<openclaw-elapsed-time
                  .startMs=${session.startedAt}
                  .endMs=${session.endedAt ?? null}
                ></openclaw-elapsed-time>`
              : nothing}</span
        >
        ${session.isChild
          ? nothing
          : html`<span class="session-row-actions">
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
                ?disabled=${!data.connected}
                @click=${() => callbacks.pinSession(session)}
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
                aria-expanded=${String(data.sessionMenuKey === session.key)}
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  const trigger = event.currentTarget as HTMLElement;
                  callbacks.toggleSessionMenu(session, menuSession, trigger);
                }}
              >
                ${icons.moreHorizontal}
              </button>
            </span>`}
      </span>
    </div>
  `;
  // Marquee state mutates the row DOM; keying prevents cross-session reuse.
  return keyed(session.key, row);
}

export function renderSessionTree(params: {
  context: SessionListRenderContext;
  session: SidebarRecentSession;
}): TemplateResult {
  const { context, session } = params;
  const expanded = context.data.expandedSessionKeys.has(session.key);
  const visibleChildren = visibleSessionChildren({
    session,
    fullyShownChildSessionKeys: context.data.fullyShownChildSessionKeys,
  });
  const hiddenChildCount = session.children.length - visibleChildren.length;
  return html`<div class="sidebar-session-tree" data-session-tree=${session.key}>
    ${renderRecentSession({ context, session })}
    ${expanded
      ? html`<div
          class="sidebar-session-tree__children"
          aria-label=${t("sessionsView.childSessions")}
        >
          ${visibleChildren.map((child) => renderSessionTree({ context, session: child }))}
          ${hiddenChildCount > 0
            ? html`<button
                class="sidebar-session-tree__show-more"
                type="button"
                data-show-more-children=${session.key}
                aria-label=${t("sessionsView.showMoreChildren", {
                  count: String(hiddenChildCount),
                })}
                @click=${() => context.callbacks.showAllSessionChildren(session.key)}
              >
                ${t("sessionsView.showMoreChildren", { count: String(hiddenChildCount) })}
              </button>`
            : nothing}
          ${session.loadingChildren && session.children.length === 0
            ? html`<span class="sidebar-session-tree__loading">${t("common.loading")}</span>`
            : nothing}
        </div>`
      : nothing}
  </div>`;
}

export function renderPinnedSidebarSession(params: {
  context: SessionListRenderContext;
  session: SidebarRecentSession;
}): TemplateResult {
  return renderSessionTree(params);
}

export function renderCatalogBackingSession(params: {
  context: SessionListRenderContext;
  session: SidebarRecentSession;
  display: CatalogBackingSessionDisplay;
}) {
  return renderRecentSession(params);
}
