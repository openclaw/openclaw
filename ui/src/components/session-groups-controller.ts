import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  parseSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  serializeSidebarEntry,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { reorderSessionCustomGroups } from "../lib/sessions/custom-groups.ts";
import {
  readSessionDragData,
  readSessionGroupDragData,
  readSidebarRouteDragData,
  sessionDragActive,
  sessionGroupDragActive,
  sidebarRouteDragActive,
  writeSidebarRouteDragData,
} from "../lib/sessions/drag.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import {
  loadStoredCollapsedSessionSections,
  storeSidebarSessionStatusFilter,
  storeCollapsedSessionSections,
  storeSidebarSessionsGrouping,
  storeSidebarSessionsShowCron,
  type SidebarRecentSession,
  type SidebarSessionGroupDropTarget,
  type SidebarSessionMutationResult,
  type SidebarSessionMutationScope,
  type SidebarSessionPatch,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

interface SessionGroupsControllerHost extends ReactiveControllerHost {
  readonly sessionData: Pick<
    SessionDataController,
    | "beginSessionMutation"
    | "isSessionMutationScopeCurrent"
    | "publishSessionMutationError"
    | "refreshSidebarSessions"
    | "resetForStatusFilter"
  >;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsStatusFilter: SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  knownSessionGroups(): string[];
  patchSession(
    session: SidebarRecentSession,
    patch: SidebarSessionPatch,
    scope?: SidebarSessionMutationScope | null,
  ): Promise<SidebarSessionMutationResult>;
  patchSessions(
    rows: readonly SidebarRecentSession[],
    patch: SidebarSessionPatch,
    scope?: SidebarSessionMutationScope | null,
  ): Promise<SidebarSessionMutationResult>;
  reconciledSidebarZone(): { sidebarEntries: readonly string[] };
}

/** Custom session groups, collapse state, and drag-and-drop assignment. */
export class SessionGroupsController implements ReactiveController {
  collapsedSessionSections = loadStoredCollapsedSessionSections();
  draggingSessionKey: string | null = null;
  draggingSessionGroup: string | null = null;
  sessionDropTarget: string | null = null;
  sessionGroupDropTarget: SidebarSessionGroupDropTarget | null = null;
  draggingSidebarEntry: string | null = null;
  sidebarZoneDropTarget: {
    entry: string;
    position: "before" | "after";
  } | null = null;
  sessionListRemovalDrop = false;

  constructor(private readonly host: SessionGroupsControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {}

  startSidebarRouteDrag(event: DragEvent, route: SidebarNavRoute) {
    if (!event.dataTransfer) {
      return;
    }
    writeSidebarRouteDragData(event.dataTransfer, route);
    this.draggingSidebarEntry = serializeSidebarEntry({ type: "route", route });
    this.host.requestUpdate();
  }

  startSidebarWorkboardDrag(event: DragEvent, boardId: string) {
    if (!event.dataTransfer) {
      return;
    }
    const entry = serializeSidebarEntry({ type: "workboard", boardId });
    writeSidebarRouteDragData(event.dataTransfer, entry);
    this.draggingSidebarEntry = entry;
    this.host.requestUpdate();
  }

  finishSidebarEntryDrag() {
    this.draggingSidebarEntry = null;
    this.host.requestUpdate();
    this.draggingSessionKey = null;
    this.host.requestUpdate();
    this.sidebarZoneDropTarget = null;
    this.host.requestUpdate();
    this.sessionListRemovalDrop = false;
    this.host.requestUpdate();
  }

  startSessionDrag(session: SidebarRecentSession): void {
    this.draggingSessionKey = session.key;
    this.host.requestUpdate();
    this.draggingSidebarEntry = session.pinned ? `session:${session.key}` : null;
    this.host.requestUpdate();
  }

  finishSessionDrag(): void {
    this.finishSidebarEntryDrag();
    this.sessionDropTarget = null;
    this.host.requestUpdate();
  }

  startSessionGroupDrag(group: string): void {
    this.draggingSessionGroup = group;
    this.host.requestUpdate();
  }

  finishSessionGroupDrag(): void {
    this.draggingSessionGroup = null;
    this.host.requestUpdate();
    this.sessionGroupDropTarget = null;
    this.host.requestUpdate();
  }

  private draggedSidebarEntry(dataTransfer: DataTransfer | null): string | null {
    const route = readSidebarRouteDragData(dataTransfer);
    if (route && SIDEBAR_NAV_ROUTES.includes(route as SidebarNavRoute)) {
      return serializeSidebarEntry({ type: "route", route: route as SidebarNavRoute });
    }
    const dynamicEntry = parseSidebarEntry(route);
    if (dynamicEntry?.type === "workboard") {
      return serializeSidebarEntry(dynamicEntry);
    }
    const sessionKey = readSessionDragData(dataTransfer);
    return sessionKey ? serializeSidebarEntry({ type: "session", key: sessionKey }) : null;
  }

  handleSidebarZoneDragOver(event: DragEvent, targetEntry?: string) {
    if (!sidebarRouteDragActive(event.dataTransfer) && !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (!targetEntry) {
      this.sidebarZoneDropTarget = null;
      this.host.requestUpdate();
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const bounds = target.getBoundingClientRect();
    this.sidebarZoneDropTarget = {
      entry: targetEntry,
      position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    };
    this.host.requestUpdate();
  }

  handleSidebarZoneDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    this.sidebarZoneDropTarget = null;
    this.host.requestUpdate();
  }

  /** Insert `entry` into the freshest canonical order at the captured drop slot. */
  private writeSidebarEntryAt(
    entry: string,
    targetEntry: string | undefined,
    position: "before" | "after" | undefined,
  ) {
    const next = this.host
      .reconciledSidebarZone()
      .sidebarEntries.filter((candidate) => candidate !== entry);
    const targetIndex = targetEntry ? next.indexOf(targetEntry) : -1;
    const offset = position === "after" ? 1 : 0;
    next.splice(targetIndex < 0 ? next.length : targetIndex + offset, 0, entry);
    this.host.onUpdateSidebarEntries?.(next);
  }

  handleSidebarZoneDrop(event: DragEvent, targetEntry?: string) {
    const entry = this.draggedSidebarEntry(event.dataTransfer);
    if (!entry) {
      return;
    }
    // Consume before the self-drop bailout: an unhandled drop would bubble to
    // the zone container and append the entry at the end.
    event.preventDefault();
    event.stopPropagation();
    if (targetEntry === entry) {
      this.finishSidebarEntryDrag();
      return;
    }
    const position = this.sidebarZoneDropTarget?.position;
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (session && !session.pinned) {
      // Persist the dropped slot only once the pin lands, and recompute
      // against the then-current order: a failed patch must not leave an
      // unpinned slot behind, and a stale snapshot must not undo zone edits
      // that raced the request.
      void this.host.patchSession(session, { pinned: true }).then((result) => {
        if (result === "completed") {
          this.writeSidebarEntryAt(entry, targetEntry, position);
        }
      });
    } else {
      this.writeSidebarEntryAt(entry, targetEntry, position);
    }
    this.finishSidebarEntryDrag();
  }

  private removeSidebarEntry(entry: string) {
    const next = this.host
      .reconciledSidebarZone()
      .sidebarEntries.filter((candidate) => candidate !== entry);
    this.host.onUpdateSidebarEntries?.(next);
  }

  handleSessionListDragOver(event: DragEvent) {
    const routeDrag = sidebarRouteDragActive(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (!routeDrag && !session?.pinned) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.sessionListRemovalDrop = true;
    this.host.requestUpdate();
  }

  handleSessionListDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) {
      this.sessionListRemovalDrop = false;
      this.host.requestUpdate();
    }
  }

  handleSessionListDrop(event: DragEvent) {
    const draggedNavigation = readSidebarRouteDragData(event.dataTransfer);
    const dynamicEntry = parseSidebarEntry(draggedNavigation);
    const entry =
      draggedNavigation && SIDEBAR_NAV_ROUTES.includes(draggedNavigation as SidebarNavRoute)
        ? ({ type: "route", route: draggedNavigation as SidebarNavRoute } as const)
        : dynamicEntry?.type === "workboard"
          ? dynamicEntry
          : null;
    if (entry) {
      event.preventDefault();
      this.removeSidebarEntry(serializeSidebarEntry(entry));
      this.finishSidebarEntryDrag();
      return;
    }
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
    if (session?.pinned) {
      event.preventDefault();
      // patchSession prunes the persisted zone entry once the unpin lands.
      void this.host.patchSession(session, { pinned: false });
    }
    this.finishSidebarEntryDrag();
  }

  private async rememberSessionGroup(
    name: string,
    scope: SidebarSessionMutationScope,
  ): Promise<SidebarSessionMutationResult> {
    const groups = this.host.knownSessionGroups();
    if (groups.includes(name)) {
      return "completed";
    }
    try {
      await scope.sessions.groupsPut([...groups, name]);
      return this.host.sessionData.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
    } catch (error) {
      if (!this.host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      this.host.sessionData.publishSessionMutationError(scope, error);
      return "failed";
    }
  }

  renameSession(session: SidebarRecentSession) {
    const nextLabel = window.prompt(t("sessionsView.renameSessionPrompt"), session.label);
    if (nextLabel === null) {
      return;
    }
    void this.host.patchSession(session, { label: normalizeOptionalString(nextLabel) ?? null });
  }

  createSessionGroup(sessions: readonly SidebarRecentSession[] = []) {
    const name = window.prompt(t("sessionsView.newGroupPrompt"))?.trim();
    if (!name) {
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      if ((await this.rememberSessionGroup(name, scope)) !== "completed") {
        return;
      }
      if (sessions.length > 0) {
        await this.host.patchSessions(sessions, { category: name }, scope);
      } else if (this.host.sessionData.isSessionMutationScopeCurrent(scope)) {
        // Header-created groups start empty; re-render so the section shows up.
        this.host.requestUpdate();
      }
    })();
  }

  renameSessionGroupFromMenu(group: string) {
    const next = window.prompt(t("sessionsView.renameGroupPrompt"), group)?.trim();
    if (!next || next === group) {
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    // Collapse keys follow only a confirmed Gateway rename. A stale completion
    // must not rewrite storage owned by the replacement connection.
    void (async () => {
      try {
        const outcome = await scope.sessions.groupsRename(group, next);
        if (
          outcome !== "completed" ||
          !this.host.sessionData.isSessionMutationScopeCurrent(scope)
        ) {
          return;
        }
        const from = `category:${group}`;
        if (this.collapsedSessionSections.has(from)) {
          const collapsed = new Set(this.collapsedSessionSections);
          collapsed.delete(from);
          collapsed.add(`category:${next}`);
          this.saveCollapsedSessionSections(collapsed);
        }
        this.host.requestUpdate();
      } catch (error) {
        this.host.sessionData.publishSessionMutationError(scope, error);
      }
    })();
  }

  deleteSessionGroupFromMenu(group: string) {
    if (!window.confirm(t("sessionsView.deleteGroupConfirm", { group }))) {
      return;
    }
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      try {
        const outcome = await scope.sessions.groupsDelete(group);
        if (
          outcome !== "completed" ||
          !this.host.sessionData.isSessionMutationScopeCurrent(scope)
        ) {
          return;
        }
        const collapsed = new Set(this.collapsedSessionSections);
        collapsed.delete(`category:${group}`);
        this.saveCollapsedSessionSections(collapsed);
        this.host.requestUpdate();
      } catch (error) {
        this.host.sessionData.publishSessionMutationError(scope, error);
      }
    })();
  }

  saveCollapsedSessionSections(sections: ReadonlySet<string>) {
    this.collapsedSessionSections = new Set(sections);
    this.host.requestUpdate();
    try {
      storeCollapsedSessionSections(sections);
    } catch {
      // Group membership and ordering remain usable without local persistence.
    }
  }

  toggleSection(sectionId: string) {
    const collapsed = new Set(this.collapsedSessionSections);
    if (collapsed.has(sectionId)) {
      collapsed.delete(sectionId);
    } else {
      collapsed.add(sectionId);
    }
    this.saveCollapsedSessionSections(collapsed);
  }

  private reorderSessionGroup(source: string, target: string, position: "before" | "after") {
    const groups = reorderSessionCustomGroups(
      this.host.knownSessionGroups(),
      source,
      target,
      position,
    );
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      try {
        await scope.sessions.groupsPut(groups);
        if (this.host.sessionData.isSessionMutationScopeCurrent(scope)) {
          this.host.requestUpdate();
        }
      } catch (error) {
        this.host.sessionData.publishSessionMutationError(scope, error);
      }
    })();
  }

  assignSessionCategory(
    session: SidebarRecentSession,
    category: string | null,
    patch: { pinned?: boolean } = {},
  ) {
    const scope = this.host.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    void (async () => {
      if (category && (await this.rememberSessionGroup(category, scope)) !== "completed") {
        return;
      }
      await this.host.patchSession(session, { category, ...patch }, scope);
    })();
  }

  sectionDragOver(event: DragEvent, sectionId: string, category?: string) {
    const dataTransfer = event.dataTransfer;
    if (
      category &&
      sessionGroupDragActive(dataTransfer) &&
      this.draggingSessionGroup !== category
    ) {
      event.preventDefault();
      if (dataTransfer) {
        dataTransfer.dropEffect = "move";
      }
      const target = event.currentTarget as HTMLElement;
      const bounds = target.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      this.sessionGroupDropTarget = { group: category, position };
      this.host.requestUpdate();
      this.sessionDropTarget = null;
      this.host.requestUpdate();
      return;
    }
    if (!sessionDragActive(dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.host.requestUpdate();
    this.sessionGroupDropTarget = null;
    this.host.requestUpdate();
  }

  sectionDragLeave(event: DragEvent, sectionId: string, category?: string) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    if (this.sessionDropTarget === sectionId) {
      this.sessionDropTarget = null;
      this.host.requestUpdate();
    }
    if (category && this.sessionGroupDropTarget?.group === category) {
      this.sessionGroupDropTarget = null;
      this.host.requestUpdate();
    }
  }

  sectionDrop(event: DragEvent, sectionId: string, category?: string) {
    const sourceGroup = readSessionGroupDragData(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    if (!sourceGroup && !sessionKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (sourceGroup && category && sourceGroup !== category) {
      const position =
        this.sessionGroupDropTarget?.group === category
          ? this.sessionGroupDropTarget.position
          : "before";
      this.reorderSessionGroup(sourceGroup, category, position);
    } else {
      // Rows can be dragged from a browsed agent section, so search all caches.
      const session = sessionKey ? this.host.findSidebarSessionByKey(sessionKey) : undefined;
      if (session && sectionId === "pinned") {
        if (!session.pinned) {
          void this.host.patchSession(session, { pinned: true });
        }
      } else if (session) {
        const nextCategory = category ?? null;
        if (session.category !== nextCategory || session.pinned) {
          // The pinned:false leg prunes the persisted zone entry via patchSession.
          this.assignSessionCategory(
            session,
            nextCategory,
            session.pinned ? { pinned: false } : {},
          );
        }
      }
    }
    this.finishSidebarEntryDrag();
    this.draggingSessionGroup = null;
    this.host.requestUpdate();
    this.sessionDropTarget = null;
    this.host.requestUpdate();
    this.sessionGroupDropTarget = null;
    this.host.requestUpdate();
  }

  setSessionsGrouping(grouping: SidebarSessionsGrouping) {
    this.host.sessionsGrouping = grouping;
    try {
      storeSidebarSessionsGrouping(grouping);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  setSessionsShowCron(show: boolean) {
    this.host.sessionsShowCron = show;
    try {
      storeSidebarSessionsShowCron(show);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  setSessionsStatusFilter(statusFilter: SidebarSessionStatusFilter) {
    if (statusFilter === this.host.sessionsStatusFilter) {
      return;
    }
    this.host.sessionsStatusFilter = statusFilter;
    this.host.clearSessionSelection();
    this.host.sessionData.resetForStatusFilter(statusFilter);
    try {
      storeSidebarSessionStatusFilter(statusFilter);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
    void this.host.sessionData.refreshSidebarSessions();
  }
}
