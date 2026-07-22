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
    // A fresh draft must be visible where it will l: genuinely expand a
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
        l: this.sidebarLiveActivity,
        n: this.sidebarNarrationLines,
        h: this.sidebarObserverDigests,
        p: pullRequestStates,
        a: this.approvalBadgeSnapshot(),
        s: this.selectedSessionKeys,
        d: this.draggingSessionKey,
        o: this.connected,
        v: this.presencePayload,
        i: this.presenceInstanceId,
        x: expandedSessionKeys,
        f: this.fullyShownChildSessionKeys,
        g: this.sessionsGrouping,
        c: this.collapsedSessionSections,
        dg: this.draggingSessionGroup,
        q: this.sessionDropTarget,
        gd: this.sessionGroupDropTarget,
        z: this.sessionSortMenuPosition !== null,
        m: this.sessionMenu?.session.key ?? null,
        gm: this.sessionGroupMenu?.group ?? null,
        t: this.sessionsStatusFilter,
        r: this.sessionListRemovalDrop,
        e: this.sessionMutationError,
        w: this.sessionOwnershipVisible,
      },
      cb: {
        sd: (session) => {
          this.draggingSessionKey = session.key;
          this.draggingSidebarEntry = session.pinned ? `session:${session.key}` : null;
        },
        ed: () => {
          this.finishSidebarEntryDrag();
          this.sessionDropTarget = null;
        },
        om: this.openSessionMenuForRow.bind(this),
        rc: this.handleSessionRowClick.bind(this),
        ch: this.toggleSessionChildren.bind(this),
        pin: (session) => void this.patchSession(session, { pinned: !session.pinned }),
        mc: (session, menuSession, trigger) => {
          if (this.sessionMenu?.session.key === session.key) {
            this.closeSessionMenu();
            return;
          }
          const rect = trigger.getBoundingClientRect();
          this.openSessionMenuForRow(menuSession, rect.right, rect.bottom + 4, trigger);
        },
        sh: this.showAllSessionChildren.bind(this),
        ov: this.handleSessionSectionDragOver.bind(this),
        lv: this.handleSessionSectionDragLeave.bind(this),
        sp: this.handleSessionSectionDrop.bind(this),
        gs: (group) => {
          this.draggingSessionGroup = group;
        },
        ge: () => {
          this.draggingSessionGroup = null;
          this.sessionGroupDropTarget = null;
        },
        gm: this.openSessionGroupMenu.bind(this),
        section: this.toggleSessionSection.bind(this),
        z: this.toggleSessionSortMenu.bind(this),
        ns: () => {
          this.onOpenNewSession?.(this.expandedAgentId());
        },
        sl: (limit) => {
          this.visibleSessionLimit = limit;
        },
        cl: this.clearSessionSelection.bind(this),
        lo: this.handleSessionListDragOver.bind(this),
        ll: this.handleSessionListDragLeave.bind(this),
        ld: this.handleSessionListDrop.bind(this),
        di: () => {
          this.sessionMutationError = null;
        },
        cg: () => {
          const next = this.catalogProjectGrouping === "project" ? "none" : "project";
          storeSidebarCatalogGrouping(next);
          this.catalogProjectGrouping = next;
        },
        mo: this.loadMoreSessionCatalog.bind(this),
        tg: this.onOpenNewSession,
        nv: this.onNavigate,
        ct: this.catalogMenu.open.bind(this.catalogMenu),
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
      empty: visibleSessions.length === 0,
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
        basePath: this.basePath,
        routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
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
