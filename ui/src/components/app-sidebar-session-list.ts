import type { PropertyValues, TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { renderSessionList } from "./app-sidebar-session-list-render.ts";
import { AppSidebarSessionNarrationElement } from "./app-sidebar-session-narration-element.ts";
import {
  renderPinnedSidebarSession as renderPinnedSidebarSessionTemplate,
  visibleSessionChildren as selectVisibleSessionChildren,
  type SessionListRenderContext,
} from "./app-sidebar-session-row-render.ts";
import {
  loadStoredSidebarCatalogGrouping,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";

function collectSessionTreeRows(rows: readonly SidebarRecentSession[]): SidebarRecentSession[] {
  const collected: SidebarRecentSession[] = [];
  const append = (row: SidebarRecentSession) => {
    collected.push(row);
    row.children.forEach(append);
  };
  rows.forEach(append);
  return collected;
}

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

  protected visibleSessionChildren(session: SidebarRecentSession): readonly SidebarRecentSession[] {
    return selectVisibleSessionChildren({
      session,
      fullyShownChildSessionKeys: this.fullyShownChildSessionKeys,
    });
  }

  private createSessionListRenderContext(
    rows: readonly SidebarRecentSession[],
  ): SessionListRenderContext {
    const treeRows = collectSessionTreeRows(rows);
    const pullRequestStates = new Map<string, SessionPullRequestIndicatorState>();
    const expandedSessionKeys = new Set<string>();
    for (const row of treeRows) {
      pullRequestStates.set(
        row.key,
        row.worktreeId ? this.sessionPullRequestIndicatorState(row.key, row.worktreeId) : "none",
      );
      if (this.isSessionChildrenExpanded(row)) {
        expandedSessionKeys.add(row.key);
      }
    }

    return {
      data: {
        sidebarLiveActivity: this.sidebarLiveActivity,
        narrationLines: this.sidebarNarrationLines,
        observerDigests: this.sidebarObserverDigests,
        pullRequestStates,
        approvalBadges: this.approvalBadgeSnapshot(),
        selectedSessionKeys: this.selectedSessionKeys,
        draggingSessionKey: this.draggingSessionKey,
        connected: this.connected,
        presencePayload: this.presencePayload,
        presenceInstanceId: this.presenceInstanceId,
        expandedSessionKeys,
        fullyShownChildSessionKeys: this.fullyShownChildSessionKeys,
        sessionsGrouping: this.sessionsGrouping,
        collapsedSessionSections: this.collapsedSessionSections,
        draggingSessionGroup: this.draggingSessionGroup,
        sessionDropTarget: this.sessionDropTarget,
        sessionGroupDropTarget: this.sessionGroupDropTarget,
        sessionSortMenuOpen: this.sessionSortMenuPosition !== null,
        sessionMenuKey: this.sessionMenu?.session.key ?? null,
        sessionGroupMenuGroup: this.sessionGroupMenu?.group ?? null,
        sessionsStatusFilter: this.sessionsStatusFilter,
        sessionListRemovalDrop: this.sessionListRemovalDrop,
        sessionMutationError: this.sessionMutationError,
        sessionOwnershipVisible: this.sessionOwnershipVisible,
        sessionCreatorOptions: this.sessionOwnershipVisible ? this.sessionCreatorOptions : [],
        sessionCreatorFilterId: this.sessionCreatorFilterActive
          ? this.sessionCreatorFilterId
          : null,
      },
      callbacks: {
        startSessionDrag: (session) => {
          this.draggingSessionKey = session.key;
          this.draggingSidebarEntry = session.pinned ? `session:${session.key}` : null;
        },
        finishSessionDrag: () => {
          this.finishSidebarEntryDrag();
          this.sessionDropTarget = null;
        },
        openSessionMenuAt: (session, x, y, trigger) =>
          this.openSessionMenuForRow(session, x, y, trigger),
        handleSessionRowClick: (event, session) => this.handleSessionRowClick(event, session),
        toggleSessionChildren: (session) => this.toggleSessionChildren(session),
        pinSession: (session) => void this.patchSession(session, { pinned: !session.pinned }),
        toggleSessionMenu: (session, menuSession, trigger) => {
          if (this.sessionMenu?.session.key === session.key) {
            this.closeSessionMenu();
            return;
          }
          const rect = trigger.getBoundingClientRect();
          this.openSessionMenuForRow(menuSession, rect.right, rect.bottom + 4, trigger);
        },
        showAllSessionChildren: (sessionKey) => this.showAllSessionChildren(sessionKey),
        handleSessionSectionDragOver: (event, sectionId, group) =>
          this.handleSessionSectionDragOver(event, sectionId, group),
        handleSessionSectionDragLeave: (event, sectionId, group) =>
          this.handleSessionSectionDragLeave(event, sectionId, group),
        handleSessionSectionDrop: (event, sectionId, group) =>
          this.handleSessionSectionDrop(event, sectionId, group),
        startSessionGroupDrag: (group) => {
          this.draggingSessionGroup = group;
        },
        finishSessionGroupDrag: () => {
          this.draggingSessionGroup = null;
          this.sessionGroupDropTarget = null;
        },
        openSessionGroupMenu: (group, x, y, trigger) =>
          this.openSessionGroupMenu(group, x, y, trigger),
        toggleSessionSection: (sectionId) => this.toggleSessionSection(sectionId),
        toggleSessionSortMenu: (trigger) => this.toggleSessionSortMenu(trigger),
        openNewSessionForExpandedAgent: () => {
          this.onOpenNewSession?.(this.expandedAgentId());
        },
        setVisibleSessionLimit: (limit) => {
          this.visibleSessionLimit = limit;
        },
        clearSessionSelection: () => this.clearSessionSelection(),
        handleSessionListDragOver: (event) => this.handleSessionListDragOver(event),
        handleSessionListDragLeave: (event) => this.handleSessionListDragLeave(event),
        handleSessionListDrop: (event) => this.handleSessionListDrop(event),
        dismissSessionMutationError: () => {
          this.sessionMutationError = null;
        },
        changeSessionCreatorFilter: (creatorId) => {
          this.sessionCreatorFilterId = creatorId;
          void this.context?.sessions.setCreatorFilter(creatorId);
        },
        toggleCatalogProjectGrouping: () => {
          const next = this.catalogProjectGrouping === "project" ? "none" : "project";
          storeSidebarCatalogGrouping(next);
          this.catalogProjectGrouping = next;
        },
        loadMoreSessionCatalog: (catalogId) => void this.loadMoreSessionCatalog(catalogId),
        onOpenNewSession: this.onOpenNewSession,
        onNavigate: this.onNavigate,
        openCatalogSessionMenu: (request, x, y, trigger) =>
          this.catalogMenu.open(request, x, y, trigger),
        openCatalogSessionInTerminal: (key) => openCatalogSessionInTerminal(key),
      },
    };
  }

  protected renderPinnedSidebarSession(session: SidebarRecentSession): TemplateResult {
    return renderPinnedSidebarSessionTemplate({
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
      catalogs: {
        catalogs: this.sessionCatalogs,
        connected: context.data.connected,
        basePath: this.basePath,
        routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
        collapsedSections: context.data.collapsedSessionSections,
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
