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
    live: boolean;
    narration: ReadonlyMap<string, string>;
    digests: ReadonlyMap<string, SessionObserverDigest>;
    prStates: ReadonlyMap<string, SessionPullRequestIndicatorState>;
    approval: ApprovalBadgeSnapshot;
    selected: ReadonlySet<string>;
    drag: string | null;
    connected: boolean;
    viewers: unknown;
    viewerId: string | undefined;
    expanded: ReadonlySet<string>;
    fullKeys: ReadonlySet<string>;
    grouping: SidebarSessionsGrouping;
    collapsed: ReadonlySet<string>;
    dragGroup: string | null;
    drop: string | null;
    gDrop: SidebarSessionGroupDropTarget | null;
    sort: boolean;
    menu: string | null;
    gMenu: string | null;
    status: SidebarSessionStatusFilter;
    remove: boolean;
    error: string | null;
    owners: boolean;
  };
  callbacks: {
    startDrag: (session: SidebarRecentSession) => void;
    endDrag: () => void;
    openMenu: (session: SidebarRecentSession, x: number, y: number, trigger?: HTMLElement) => void;
    rowClick: (event: MouseEvent, session: SidebarRecentSession) => void;
    children: (session: SidebarRecentSession) => void;
    pin: (session: SidebarRecentSession) => void;
    menuClick: (
      session: SidebarRecentSession,
      menuSession: SidebarRecentSession,
      trigger: HTMLElement,
    ) => void;
    showChildren: (sessionKey: string) => void;
    sectionOver: (event: DragEvent, sectionId: string, group?: string) => void;
    sectionLeave: (event: DragEvent, sectionId: string, group?: string) => void;
    sectionDrop: (event: DragEvent, sectionId: string, group?: string) => void;
    groupStart: (group: string) => void;
    groupEnd: () => void;
    groupMenu: (group: string, x: number, y: number, trigger: HTMLElement | null) => void;
    section: (sectionId: string) => void;
    sort: (trigger: HTMLElement) => void;
    newSession: () => void;
    setLimit: (limit: number) => void;
    clear: () => void;
    listDragOver: (event: DragEvent) => void;
    listDragLeave: (event: DragEvent) => void;
    listDrop: (event: DragEvent) => void;
    dismissError: () => void;
    catalogGroup: () => void;
    more: (catalogId: string) => Promise<void>;
    newTarget?: (agentId: string, target?: NewSessionTarget) => void;
    navigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
    catalog: (
      request: CatalogSessionMenuRequest,
      x: number,
      y: number,
      trigger?: HTMLElement,
    ) => void;
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

export function renderRecentSession(params: {
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
    sidebarLiveActivity: data.live,
    narrationLine: data.narration.get(session.key),
    observerDigest: data.digests.get(session.key) ?? null,
  });
  const { running, pinnedState, leadingIndicator } = renderSessionLeadingState(
    session,
    data.prStates.get(session.key) ?? "none",
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
    data.selected.has(session.key) ? "sidebar-recent-session--selected" : "",
    session.pinned ? "session-row-host--pinned" : "",
    running ? "session-row-host--running" : "",
    session.attention.kind === "error"
      ? "sidebar-recent-session--attention-danger"
      : session.attention.kind !== "none"
        ? "sidebar-recent-session--attention-amber"
        : "",
    data.drag === session.key ? "sidebar-recent-session--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const childrenExpanded = data.expanded.has(session.key);
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
              callbacks.startDrag(session);
            }
          }}
      @dragend=${session.isChild
        ? nothing
        : () => {
            callbacks.endDrag();
          }}
      @contextmenu=${session.isChild
        ? nothing
        : (event: MouseEvent) => {
            event.preventDefault();
            callbacks.openMenu(menuSession, event.clientX, event.clientY);
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
        @click=${(event: MouseEvent) => callbacks.rowClick(event, session)}
      >
        <span class="sidebar-session-indicator">${leadingIndicator}</span>${renderSessionOwnerChip(
          data.owners ? session.createdBy : undefined,
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
          .presencePayload=${data.viewers}
          .selfInstanceId=${data.viewerId}
          .sessionKey=${session.key}
          .maxVisible=${3}
          variant="session"
        ></openclaw-viewer-facepile>
        ${renderSessionRowBadges({
          ...session,
          pullRequest: session.pullRequest ?? display?.pullRequest,
          hasApproval: sessionHasPendingApproval(data.approval, session.key),
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
            @click=${() => callbacks.children(session)}
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
                @click=${() => callbacks.pin(session)}
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
                aria-expanded=${String(data.menu === session.key)}
                @click=${(event: MouseEvent) => {
                  event.stopPropagation();
                  const trigger = event.currentTarget as HTMLElement;
                  callbacks.menuClick(session, menuSession, trigger);
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
  const { data, callbacks } = context;
  const expanded = data.expanded.has(session.key);
  const visibleChildren = visibleSessionChildren({
    session,
    fullyShownChildSessionKeys: data.fullKeys,
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
                @click=${() => callbacks.showChildren(session.key)}
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
