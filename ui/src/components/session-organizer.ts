import {
  parseSidebarEntry,
  serializeSidebarEntry,
  type PersistedSidebarRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import {
  readSessionDragData,
  readSidebarSectionDragData,
  readSidebarRouteDragData,
  sessionDragActive,
  sidebarSectionDragActive,
  sidebarRouteDragActive,
  writeSidebarRouteDragData,
} from "../lib/sessions/drag.ts";
import {
  categoryClearReturnsToGroups,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import { isSessionDisplayMetadataPatch } from "../lib/sessions/patch.ts";
import {
  loadStoredCollapsedSessionSections,
  storeSidebarSessionStatusFilter,
  storeCollapsedSessionSections,
  storeSidebarSessionsGrouping,
  storeSidebarSessionsShowCron,
  storeSidebarSessionsShowPreview,
  storeSidebarSessionsShowSystem,
  type SidebarRecentSession,
  type SidebarSectionDropTarget,
  type SidebarSessionMutationResult,
  type SidebarSessionMutationScope,
  type SidebarSessionPatch,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { sidebarSessionHasArchiveDescendants } from "./session-menu-descendants.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";
import type { SessionOrganizerDependencies } from "./session-organizer-types.ts";

export type { SessionOrganizerDependencies } from "./session-organizer-types.ts";

type SessionOrganizerOperations = typeof import("./session-organizer-operations.runtime.ts");
export class SessionOrganizer {
  readonly sectionHeaders = new Map<string, HTMLElement>();
  collapsedSessionSections = loadStoredCollapsedSessionSections();
  draggingSessionKey: string | null = null;
  draggingSidebarSection: string | null = null;
  sessionDropTarget: string | null = null;
  sidebarSectionDropTarget: SidebarSectionDropTarget | null = null;
  draggingSidebarEntry: string | null = null;
  sidebarZoneDragActive = false;
  sidebarZoneDropTarget: {
    entry: string;
    position: "before" | "after";
  } | null = null;
  sessionListRemovalDrop = false;

  constructor(
    private readonly deps: SessionOrganizerDependencies,
    private readonly notify: () => void,
  ) {}

  private async loadOperations(
    scope: SidebarSessionMutationScope,
  ): Promise<SessionOrganizerOperations | null> {
    try {
      return await import("./session-organizer-operations.runtime.ts");
    } catch (error) {
      this.deps.sessionData.publishSessionMutationError(scope, error);
      return null;
    }
  }

  private async runOperation(
    run: (
      operations: SessionOrganizerOperations,
      scope: SidebarSessionMutationScope,
    ) => Promise<unknown>,
    allowDeferred = false,
  ): Promise<void> {
    const scope = this.deps.sessionData.beginSessionMutation(allowDeferred);
    if (scope) {
      const operations = await this.loadOperations(scope);
      if (operations) {
        await run(operations, scope);
      }
    }
  }

  readonly patchSession = async (
    session: SidebarRecentSession,
    patch: SidebarSessionPatch,
    options: { sessionScope?: boolean } = {},
  ): Promise<SidebarSessionMutationResult> => {
    const scope = this.deps.sessionData.beginSessionMutation(isSessionDisplayMetadataPatch(patch));
    if (!scope) {
      return "stale";
    }
    const operations = await this.loadOperations(scope);
    if (!operations) {
      return this.deps.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
    }
    return operations.patchSession(this.deps, session, patch, scope, options);
  };

  snoozeSessionWithUndo(
    session: SidebarRecentSession,
    snoozedUntil: number,
    rememberCustom = false,
  ): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.snoozeSessionWithUndo(this.deps, session, { snoozedUntil, rememberCustom }, scope),
    );
  }

  archiveSessionWithUndo(session: SidebarRecentSession): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.archiveSessionWithUndo(
        this.deps,
        { ...session, hasArchiveDescendants: sidebarSessionHasArchiveDescendants(session) },
        scope,
      ),
    );
  }

  promoteSession(session: SidebarRecentSession): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.promoteSession(this.deps, session, scope),
    );
  }

  async runBatchSessionAction(
    action: SessionMenuAction,
    rows: SidebarRecentSession[],
    allUnread: boolean,
  ): Promise<void> {
    if (action.kind === "new-group") {
      await this.createSessionGroup(rows);
      return;
    }
    await this.runOperation((operations, scope) =>
      operations.runBatchSessionAction(this.deps, action, rows, allUnread, scope),
    );
  }

  forkSession(session: SidebarRecentSession): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.forkSession(this.deps, session, scope),
    );
  }

  stopCloudWorker(session: SidebarRecentSession): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.stopCloudWorker(this.deps, session, scope),
    );
  }

  setSessionInvolvement(session: SidebarRecentSession, hidden: boolean): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.setSessionInvolvement(this.deps, session, hidden, scope),
    );
  }

  assignSessionOwner(
    session: SidebarRecentSession,
    owner: Pick<SessionOwnerOption, "type" | "id">,
  ): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.assignSessionOwner(this.deps, session, owner, scope),
    );
  }

  deleteSession(session: SidebarRecentSession): Promise<void> {
    // Sidebar is the surface the delete-confirm setting names, so it is the one
    // caller allowed to offer the opt-out.
    return this.runOperation((operations, scope) =>
      operations.deleteSession(this.deps, session, scope, { offerSkip: true }),
    );
  }

  isPersonalSessionPin(key: string): boolean {
    return this.deps.sidebarEntries.includes(serializeSidebarEntry({ type: "session", key }));
  }

  setPersonalSessionPin(key: string, pinned: boolean): void {
    const entry = serializeSidebarEntry({ type: "session", key });
    if (pinned) {
      if (!this.isPersonalSessionPin(key)) {
        this.writeSidebarEntryAt(entry, undefined, undefined);
      }
    } else {
      this.removeSidebarEntry(entry);
    }
  }

  startSidebarEntryDrag(event: DragEvent, entry: SidebarZoneEntry): void {
    if (!event.dataTransfer) {
      return;
    }
    const serialized = serializeSidebarEntry(entry);
    writeSidebarRouteDragData(event.dataTransfer, serialized);
    this.draggingSidebarEntry = serialized;
    this.sidebarZoneDragActive = this.isSidebarZoneDragCompatible(event.dataTransfer);
    this.notify();
  }

  startSidebarRouteDrag(event: DragEvent, route: PersistedSidebarRoute) {
    if (!event.dataTransfer) {
      return;
    }
    writeSidebarRouteDragData(event.dataTransfer, route);
    this.draggingSidebarEntry = serializeSidebarEntry({ type: "route", route });
    this.sidebarZoneDragActive = true;
    this.notify();
  }

  startSidebarPluginDrag(event: DragEvent, key: string) {
    if (!event.dataTransfer) {
      return;
    }
    const entry = serializeSidebarEntry({ type: "plugin", key });
    writeSidebarRouteDragData(event.dataTransfer, entry);
    this.draggingSidebarEntry = entry;
    this.sidebarZoneDragActive = true;
    this.notify();
  }

  finishSidebarEntryDrag() {
    this.draggingSidebarEntry = null;
    this.draggingSessionKey = null;
    this.sidebarZoneDropTarget = null;
    this.sidebarZoneDragActive = false;
    this.sessionListRemovalDrop = false;
    this.notify();
  }

  get isDraggingChildSession(): boolean {
    return Boolean(
      this.draggingSessionKey &&
      this.deps.findSidebarMenuSessionByKey(this.draggingSessionKey)?.isChild,
    );
  }

  startSessionDrag(session: SidebarRecentSession): void {
    this.draggingSessionKey = session.key;
    this.draggingSidebarEntry = this.isPersonalSessionPin(session.key)
      ? `session:${session.key}`
      : null;
    this.sidebarZoneDragActive = session.pinnable;
    this.notify();
  }

  finishSessionDrag(): void {
    this.sessionDropTarget = null;
    this.finishSidebarEntryDrag();
  }

  startSidebarSectionDrag(sectionId: string): void {
    this.draggingSidebarSection = sectionId;
    this.notify();
  }

  finishSidebarSectionDrag(): void {
    this.draggingSidebarSection = null;
    this.sidebarSectionDropTarget = null;
    this.notify();
  }

  private draggedSidebarNavigation(dataTransfer: DataTransfer | null) {
    const route = readSidebarRouteDragData(dataTransfer);
    const routeEntry = parseSidebarEntry(route ? `route:${route}` : null);
    if (routeEntry?.type === "route") {
      return routeEntry;
    }
    return parseSidebarEntry(route);
  }

  private draggedSidebarEntry(dataTransfer: DataTransfer | null): string | null {
    const navigation = this.draggedSidebarNavigation(dataTransfer);
    if (navigation) {
      return serializeSidebarEntry(navigation);
    }
    const sessionKey = readSessionDragData(dataTransfer);
    return sessionKey ? serializeSidebarEntry({ type: "session", key: sessionKey }) : null;
  }

  private isSidebarZoneDragCompatible(dataTransfer: DataTransfer | null): boolean {
    const entry = this.draggingSidebarEntry
      ? parseSidebarEntry(this.draggingSidebarEntry)
      : this.draggedSidebarNavigation(dataTransfer);
    // During dragover browsers protect payload reads, so use the source's key.
    const sessionKey =
      entry?.type === "session"
        ? entry.key
        : (this.draggingSessionKey ?? readSessionDragData(dataTransfer));
    if (sessionKey) {
      return this.deps.findSidebarMenuSessionByKey(sessionKey)?.pinnable !== false;
    }
    return Boolean(
      entry || sidebarRouteDragActive(dataTransfer) || sessionDragActive(dataTransfer),
    );
  }

  handleSidebarZoneDragOver(event: DragEvent, targetEntry?: string) {
    if (!this.isSidebarZoneDragCompatible(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.sidebarZoneDragActive = true;
    if (!targetEntry) {
      this.sidebarZoneDropTarget = null;
      this.notify();
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const bounds = target.getBoundingClientRect();
    this.sidebarZoneDropTarget = {
      entry: targetEntry,
      position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    };
    this.notify();
  }

  handleSidebarZoneDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    this.sidebarZoneDropTarget = null;
    this.sidebarZoneDragActive = this.isSidebarZoneDragCompatible(null);
    this.notify();
  }

  /** Insert `entry` into the freshest canonical order at the captured drop slot. */
  writeSidebarEntryAt(
    entry: string,
    targetEntry: string | undefined,
    position: "before" | "after" | undefined,
  ) {
    const next = this.deps
      .reconciledSidebarZone()
      .sidebarEntries.filter((candidate) => candidate !== entry);
    const targetIndex = targetEntry ? next.indexOf(targetEntry) : -1;
    const offset = position === "after" ? 1 : 0;
    next.splice(targetIndex < 0 ? next.length : targetIndex + offset, 0, entry);
    this.deps.onUpdateSidebarEntries?.(next);
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
    const parsedEntry = parseSidebarEntry(entry);
    const session =
      parsedEntry?.type === "session"
        ? this.deps.findSidebarMenuSessionByKey(parsedEntry.key)
        : undefined;
    if (session && !session.pinnable) {
      this.finishSidebarEntryDrag();
      return;
    }
    this.writeSidebarEntryAt(entry, targetEntry, position);
    this.finishSidebarEntryDrag();
  }

  removeSidebarEntry(entry: string) {
    const next = this.deps
      .reconciledSidebarZone()
      .sidebarEntries.filter((candidate) => candidate !== entry);
    this.deps.onUpdateSidebarEntries?.(next);
  }

  handleSessionListDragOver(event: DragEvent) {
    const routeDrag = sidebarRouteDragActive(event.dataTransfer);
    const sessionKey = this.draggingSessionKey ?? readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.deps.findSidebarMenuSessionByKey(sessionKey) : undefined;
    if (!routeDrag && !session?.isChild && !(session && this.isPersonalSessionPin(session.key))) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.sessionListRemovalDrop = true;
    this.notify();
  }

  handleSessionListDragLeave(event: DragEvent) {
    const current = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) {
      this.sessionListRemovalDrop = false;
      this.notify();
    }
  }

  handleSessionListDrop(event: DragEvent) {
    const entry = this.draggedSidebarNavigation(event.dataTransfer);
    if (entry) {
      event.preventDefault();
      const serialized = serializeSidebarEntry(entry);
      this.removeSidebarEntry(serialized);
      this.finishSidebarEntryDrag();
      return;
    }
    const sessionKey = readSessionDragData(event.dataTransfer);
    const session = sessionKey ? this.deps.findSidebarMenuSessionByKey(sessionKey) : undefined;
    if (session?.isChild) {
      event.preventDefault();
      event.stopPropagation();
      void this.promoteSession(session);
    } else if (session && this.isPersonalSessionPin(session.key)) {
      event.preventDefault();
      this.setPersonalSessionPin(session.key, false);
    }
    this.finishSidebarEntryDrag();
  }

  /** A dialog that never opens still owes the operator a visible outcome. */
  private async loadDialog<T>(load: Promise<T>): Promise<T | null> {
    try {
      return await load;
    } catch (error) {
      const scope = this.deps.sessionData.beginSessionMutation();
      if (scope) {
        this.deps.sessionData.publishSessionMutationError(scope, error);
      }
      return null;
    }
  }

  renameSession(session: SidebarRecentSession): Promise<void> {
    return this.runOperation(
      (operations, scope) => operations.renameSession(this.deps, session, scope),
      true,
    );
  }

  async createSessionGroup(sessions: readonly SidebarRecentSession[] = []): Promise<void> {
    const scope = this.deps.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const signal = this.deps.sessionData.sessionDraftSignal;
    const dialogs = await this.loadDialog(import("./session-organizer-group-dialogs.runtime.ts"));
    await dialogs?.createSessionGroupDialog(this.deps, scope, signal, sessions, this.notify);
  }

  async renameSessionGroupFromMenu(group: string): Promise<void> {
    const scope = this.deps.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const signal = this.deps.sessionData.sessionDraftSignal;
    const dialogs = await this.loadDialog(import("./session-organizer-group-dialogs.runtime.ts"));
    await dialogs?.renameSessionGroupDialog(this.deps, scope, signal, group, (next) => {
      const from = `category:${group}`;
      if (this.collapsedSessionSections.has(from)) {
        const collapsed = new Set(this.collapsedSessionSections);
        collapsed.delete(from);
        collapsed.add(`category:${next}`);
        this.saveCollapsedSessionSections(collapsed);
      }
      this.notify();
    });
  }

  deleteSessionGroupFromMenu(group: string): Promise<void> {
    return this.runOperation(async (operations, scope) => {
      if (!(await operations.deleteSessionGroup(this.deps, group, scope))) {
        return;
      }
      const collapsed = new Set(this.collapsedSessionSections);
      collapsed.delete(`category:${group}`);
      this.saveCollapsedSessionSections(collapsed);
    });
  }

  async editSessionGroupDefaults(group: string): Promise<void> {
    const scope = this.deps.sessionData.beginSessionMutation();
    if (!scope) {
      return;
    }
    const dialogs = await this.loadDialog(import("./session-organizer-group-dialogs.runtime.ts"));
    await dialogs?.editSessionGroupDefaultsDialog(this.deps, scope, group);
  }

  saveCollapsedSessionSections(sections: ReadonlySet<string>) {
    this.collapsedSessionSections = new Set(sections);
    this.notify();
    storeCollapsedSessionSections(sections);
  }

  toggleSection(sectionId: string) {
    const collapsed = new Set(this.collapsedSessionSections);
    if (!collapsed.delete(sectionId)) {
      collapsed.add(sectionId);
    }
    this.saveCollapsedSessionSections(collapsed);
  }

  reorderSidebarSection(
    sourceSectionId: string,
    targetSectionId: string,
    position: "before" | "after",
  ): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.reorderSidebarSection(
        this.deps,
        sourceSectionId,
        targetSectionId,
        position,
        scope,
        this.notify,
      ),
    );
  }

  assignSessionCategory(
    session: SidebarRecentSession,
    category: string | null,
    patch: { pinned?: boolean } = {},
  ): Promise<void> {
    return this.runOperation(
      (operations, scope) =>
        operations.assignSessionCategory(this.deps, session, category, scope, patch),
      true,
    );
  }

  private sectionAcceptsSession(
    sectionId: string,
    category: string | undefined,
    session: SidebarRecentSession | undefined,
  ): boolean {
    if (sectionId === "pinned") {
      return true;
    }
    if (
      this.deps.sessionsGrouping === "category" &&
      (sectionId === "ungrouped" || Boolean(category))
    ) {
      return true;
    }
    return (
      sectionId === "groups" &&
      Boolean(session && categoryClearReturnsToGroups(session, this.deps.sessionsGrouping))
    );
  }

  sectionDragOver(event: DragEvent, sectionId: string, category?: string) {
    const dataTransfer = event.dataTransfer;
    if (sidebarSectionDragActive(dataTransfer) && this.draggingSidebarSection !== sectionId) {
      event.preventDefault();
      if (dataTransfer) {
        dataTransfer.dropEffect = "move";
      }
      const target = event.currentTarget as HTMLElement;
      const bounds = (this.sectionHeaders.get(sectionId) ?? target).getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      this.sidebarSectionDropTarget = { sectionId, position };
      this.sessionDropTarget = null;
      this.notify();
      return;
    }
    if (!sessionDragActive(dataTransfer)) {
      return;
    }
    // Browsers protect transferred data during dragover. Use the key recorded
    // at dragstart for hover eligibility; sectionDrop reads the payload itself.
    const session = this.draggingSessionKey
      ? this.deps.findSidebarMenuSessionByKey(this.draggingSessionKey)
      : undefined;
    if (!this.sectionAcceptsSession(sectionId, category, session)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sessionDropTarget = sectionId;
    this.sidebarSectionDropTarget = null;
    this.notify();
  }

  sectionDragLeave(event: DragEvent, sectionId: string, _category?: string) {
    const current = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
      return;
    }
    if (this.sessionDropTarget === sectionId) {
      this.sessionDropTarget = null;
      this.notify();
    }
    if (this.sidebarSectionDropTarget?.sectionId === sectionId) {
      this.sidebarSectionDropTarget = null;
      this.notify();
    }
  }

  sectionDrop(event: DragEvent, sectionId: string, category?: string) {
    const sourceSectionId = readSidebarSectionDragData(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    if (!sourceSectionId && !sessionKey) {
      return;
    }
    // Rows can be dragged from a browsed agent section, so search all caches.
    const session = sessionKey ? this.deps.findSidebarMenuSessionByKey(sessionKey) : undefined;
    if (!sourceSectionId && !this.sectionAcceptsSession(sectionId, category, session)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (sourceSectionId && sourceSectionId !== sectionId) {
      const position =
        this.sidebarSectionDropTarget?.sectionId === sectionId
          ? this.sidebarSectionDropTarget.position
          : "before";
      void this.reorderSidebarSection(sourceSectionId, sectionId, position);
    } else if (session && sectionId === "pinned") {
      if (session.pinnable) {
        this.setPersonalSessionPin(session.key, true);
      }
    } else if (session) {
      const nextCategory = category ?? null;
      if (session.category !== nextCategory || session.isChild) {
        void this.assignSessionCategory(session, nextCategory);
      }
    }
    this.draggingSidebarSection = null;
    this.sessionDropTarget = null;
    this.sidebarSectionDropTarget = null;
    this.finishSidebarEntryDrag();
  }

  setSessionsGrouping(grouping: SidebarSessionsGrouping) {
    this.deps.sessionsGrouping = grouping;
    storeSidebarSessionsGrouping(grouping);
    this.notify();
  }

  setSessionsShowCron(show: boolean) {
    this.deps.sessionsShowCron = show;
    storeSidebarSessionsShowCron(show);
    this.notify();
  }

  setSessionsShowPreview(show: boolean) {
    this.deps.sessionsShowPreview = show;
    storeSidebarSessionsShowPreview(show);
    this.notify();
  }

  setSessionsShowSystem(show: boolean) {
    this.deps.sessionsShowSystem = show;
    storeSidebarSessionsShowSystem(show);
    this.notify();
  }

  setSessionsStatusFilter(statusFilter: SidebarSessionStatusFilter) {
    if (statusFilter === this.deps.sessionsStatusFilter) {
      return;
    }
    this.deps.sessionsStatusFilter = statusFilter;
    this.deps.clearSessionSelection();
    this.deps.sessionData.resetSessionList();
    storeSidebarSessionStatusFilter(statusFilter);
    void this.deps.sessionData.refreshSidebarSessions();
    this.notify();
  }
}
