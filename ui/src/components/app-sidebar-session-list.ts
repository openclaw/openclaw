import type { PropertyValues, TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { renderSessionList } from "./app-sidebar-session-list-render.ts";
import { AppSidebarSessionNarrationElement } from "./app-sidebar-session-narration-element.ts";
import {
  renderSessionTree,
  type SessionListRenderContext,
} from "./app-sidebar-session-row-render.ts";
import {
  loadStoredSidebarCatalogGrouping,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import { renderSessionCreatorFilter } from "./session-owner-chip.ts";

/** Session-list presentation and catalog renderer wiring. */
export abstract class AppSidebarSessionListElement extends AppSidebarSessionNarrationElement {
  @state() protected catalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    // A fresh draft must be visible where it will live: genuinely expand a
    // collapsed Threads section (persisted) instead of overriding at render
    // time, so the header toggle keeps matching the visible state.
    if (
      changed.has("draftSessionAgentId") &&
      this.draftSessionAgentId &&
      this.collapsedSessionSections.has("ungrouped")
    ) {
      this.toggleSessionSection("ungrouped");
    }
  }

  private createSessionListRenderContext(
    rows: readonly SidebarRecentSession[],
  ): SessionListRenderContext {
    const pullRequestStates = new Map<string, SessionPullRequestIndicatorState>();
    const expandedSessionKeys = new Set<string>();
    const append = (row: SidebarRecentSession) => {
      if (row.worktreeId) {
        pullRequestStates.set(
          row.key,
          this.sessionPullRequestIndicatorState(row.key, row.worktreeId),
        );
      }
      if (this.isSessionChildrenExpanded(row)) {
        expandedSessionKeys.add(row.key);
      }
      row.children.forEach(append);
    };
    rows.forEach(append);

    return {
      data: {
        live: this.sidebarLiveActivity,
        narration: this.sidebarNarrationLines,
        digests: this.sidebarObserverDigests,
        prStates: pullRequestStates,
        approvals: this.approvalBadgeSnapshot(),
        selected: this.selectedSessionKeys,
        drag: this.draggingSessionKey,
        connected: this.connected,
        presence: this.presencePayload,
        presenceId: this.presenceInstanceId,
        expanded: expandedSessionKeys,
        fullKeys: this.fullyShownChildSessionKeys,
        grouping: this.sessionsGrouping,
        collapsed: this.collapsedSessionSections,
        dragGroup: this.draggingSessionGroup,
        drop: this.sessionDropTarget,
        groupDrop: this.sessionGroupDropTarget,
        sortOpen: this.sessionSortMenuPosition !== null,
        menuKey: this.sessionMenu?.session.key ?? null,
        groupMenu: this.sessionGroupMenu?.group ?? null,
        status: this.sessionsStatusFilter,
        remove: this.sessionListRemovalDrop,
        error: this.sessionMutationError,
        owners: this.sessionOwnershipVisible,
      },
      callbacks: {
        startDrag: (session) => {
          this.draggingSessionKey = session.key;
          this.draggingSidebarEntry = session.pinned ? `session:${session.key}` : null;
        },
        endDrag: () => {
          this.finishSidebarEntryDrag();
          this.sessionDropTarget = null;
        },
        openMenu: this.openSessionMenuForRow.bind(this),
        rowClick: this.handleSessionRowClick.bind(this),
        children: this.toggleSessionChildren.bind(this),
        pin: (session) => void this.patchSession(session, { pinned: !session.pinned }),
        menuClick: (session, menuSession, trigger) => {
          if (this.sessionMenu?.session.key === session.key) {
            this.closeSessionMenu();
            return;
          }
          const rect = trigger.getBoundingClientRect();
          this.openSessionMenuForRow(menuSession, rect.right, rect.bottom + 4, trigger);
        },
        showChildren: this.showAllSessionChildren.bind(this),
        sectionOver: this.handleSessionSectionDragOver.bind(this),
        sectionLeave: this.handleSessionSectionDragLeave.bind(this),
        sectionDrop: this.handleSessionSectionDrop.bind(this),
        groupStart: (group) => {
          this.draggingSessionGroup = group;
        },
        groupEnd: () => {
          this.draggingSessionGroup = null;
          this.sessionGroupDropTarget = null;
        },
        groupMenu: this.openSessionGroupMenu.bind(this),
        section: this.toggleSessionSection.bind(this),
        sort: this.toggleSessionSortMenu.bind(this),
        newSession: () => {
          this.onOpenNewSession?.(this.expandedAgentId());
        },
        setLimit: (limit) => {
          this.visibleSessionLimit = limit;
        },
        clear: this.clearSessionSelection.bind(this),
        listDragOver: this.handleSessionListDragOver.bind(this),
        listDragLeave: this.handleSessionListDragLeave.bind(this),
        listDrop: this.handleSessionListDrop.bind(this),
        dismissError: () => {
          this.sessionMutationError = null;
        },
        catalogGroup: () => {
          const next = this.catalogProjectGrouping === "project" ? "none" : "project";
          storeSidebarCatalogGrouping(next);
          this.catalogProjectGrouping = next;
        },
        more: this.loadMoreSessionCatalog.bind(this),
        newTarget: this.onOpenNewSession,
        navigate: this.onNavigate,
        catalog: this.catalogMenu.open.bind(this.catalogMenu),
      },
    };
  }

  protected renderPinnedSidebarSession(session: SidebarRecentSession): TemplateResult {
    return renderSessionTree({
      context: this.createSessionListRenderContext([session]),
      session,
    });
  }

  protected renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    const liveRows = [
      ...(this.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionRowsByAgent).flat(),
    ];
    const sidebarRowsByKey = new Map<string, SidebarRecentSession>();
    for (const row of liveRows) {
      if (!sidebarRowsByKey.has(row.key)) {
        sidebarRowsByKey.set(row.key, navigationState.toSidebarSession(row));
      }
    }
    const { sections, expandedRows, visibleRows } = this.zonedVisibleSections(visibleSessions);
    const context = this.createSessionListRenderContext([
      ...visibleSessions,
      ...sidebarRowsByKey.values(),
    ]);

    return renderSessionList({
      context,
      visibleSessions,
      sections,
      expandedRows,
      visibleRowCount: visibleRows.length,
      showDraft:
        Boolean(this.draftSessionAgentId) &&
        normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
      creatorFilter: renderSessionCreatorFilter({
        creators: this.sessionOwnershipVisible ? this.sessionCreatorOptions : [],
        selectedId: this.sessionCreatorFilterActive ? this.sessionCreatorFilterId : null,
        onChange: (creatorId) => {
          this.sessionCreatorFilterId = creatorId;
          void this.context?.sessions.setCreatorFilter(creatorId);
        },
      }),
      catalogs: {
        catalogs: this.sessionCatalogs,
        connected: context.data.connected,
        basePath: this.basePath,
        routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
        collapsedSections: context.data.collapsed,
        loadingMoreCatalogIds: this.loadingMoreSessionCatalogIds,
        projectGrouping: this.catalogProjectGrouping,
        liveRows,
        sidebarRowsByKey,
        creatorId: this.activeSessionCreatorId,
        catalogOpenTarget: this.catalogOpenTarget,
        terminalAvailable: this.terminalAvailable,
      },
    });
  }
}
