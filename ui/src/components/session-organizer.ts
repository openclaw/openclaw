import {
  parseSidebarEntry,
  serializeSidebarEntry,
  type PersistedSidebarRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import {
  readSessionDragData,
  readSidebarSectionDragData,
  readSidebarRouteDragData,
  sessionDragActive,
  sidebarSectionDragActive,
  sidebarRouteDragActive,
  writeSidebarRouteDragData,
} from "../lib/sessions/drag.ts";
import { categoryClearReturnsToGroups } from "../lib/sessions/grouping.ts";
import { isSessionDeferredPatch } from "../lib/sessions/patch.ts";
import {
  loadStoredCollapsedSessionSections,
  storeCollapsedSessionSections,
  type SidebarRecentSession,
  type SidebarSectionDropTarget,
  type SidebarSessionMutationResult,
  type SidebarSessionMutationScope,
  type SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import { sidebarSessionHasArchiveDescendants } from "./session-menu-descendants.ts";
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
    readonly deps: SessionOrganizerDependencies,
    readonly notify: () => void,
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

  async runOperation(
    run: (
      operations: SessionOrganizerOperations,
      scope: SidebarSessionMutationScope,
    ) => Promise<unknown>,
    allowDeferred = false,
  ): Promise<void> {
    const scope = this.deps.sessionData.beginSessionMutation(allowDeferred);
    if (scope) {
      try {
        const operations = await this.loadOperations(scope);
        if (operations) {
          await run(operations, scope);
        }
      } catch (error) {
        this.deps.sessionData.publishSessionMutationError(scope, error);
      }
    }
  }

  readonly patchSession = async (
    session: SidebarRecentSession,
    patch: SidebarSessionPatch,
    options: { sessionScope?: boolean } = {},
  ): Promise<SidebarSessionMutationResult> => {
    const scope = this.deps.sessionData.beginSessionMutation(isSessionDeferredPatch(patch));
    if (!scope) {
      return "stale";
    }
    const operations = await this.loadOperations(scope);
    if (!operations) {
      return this.deps.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
    }
    return operations.patchSession(this.deps, session, patch, scope, options);
  };

  archiveSessionWithUndo(session: SidebarRecentSession): Promise<void> {
    return this.runOperation(
      (operations, scope) =>
        operations.archiveSessionWithUndo(
          this.deps,
          { ...session, hasArchiveDescendants: sidebarSessionHasArchiveDescendants(session) },
          scope,
        ),
      true,
    );
  }

  promoteSession(session: SidebarRecentSession): Promise<void> {
    return this.runOperation((operations, scope) =>
      operations.promoteSession(this.deps, session, scope),
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
    const shortcut = serializeSidebarEntry({ type: "session", key: session.key, rail: true });
    this.draggingSidebarEntry = this.deps.sidebarEntries.includes(shortcut) ? shortcut : null;
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
      return serializeSidebarEntry(
        navigation.type === "session" ? { ...navigation, rail: true } : navigation,
      );
    }
    const sessionKey = readSessionDragData(dataTransfer);
    return sessionKey
      ? serializeSidebarEntry({ type: "session", key: sessionKey, rail: true })
      : null;
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
    if (!routeDrag && !session?.isChild) {
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
    }
    this.finishSidebarEntryDrag();
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

  assignSessionCategory(session: SidebarRecentSession, category: string | null): Promise<void> {
    return this.runOperation(
      (operations, scope) => operations.assignSessionCategory(this.deps, session, category, scope),
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
    // Match the rendered sections, including the saved Person preference fallback.
    const grouping = this.deps.effectiveSessionsGrouping();
    if (grouping === "category" && (sectionId === "ungrouped" || Boolean(category))) {
      return true;
    }
    return (
      sectionId === "groups" && Boolean(session && categoryClearReturnsToGroups(session, grouping))
    );
  }

  sectionDragOver(
    event: DragEvent,
    sectionId: string,
    category?: string,
    targetSessionKey?: string,
  ) {
    const dataTransfer = event.dataTransfer;
    if (
      sidebarSectionDragActive(dataTransfer) &&
      this.draggingSidebarSection !== sectionId &&
      sectionId !== "pinned"
    ) {
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
    if (sectionId === "pinned" && targetSessionKey) {
      this.sessionDropTarget = null;
      this.sidebarSectionDropTarget = null;
      this.handleSidebarZoneDragOver(
        event,
        serializeSidebarEntry({ type: "session", key: targetSessionKey }),
      );
      return;
    }
    event.preventDefault();
    if (dataTransfer) {
      dataTransfer.dropEffect = "move";
    }
    this.sidebarZoneDropTarget = null;
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

  sectionDrop(event: DragEvent, sectionId: string, category?: string, targetSessionKey?: string) {
    const sourceSectionId = readSidebarSectionDragData(event.dataTransfer);
    const sessionKey = readSessionDragData(event.dataTransfer);
    if ((!sourceSectionId && !sessionKey) || (sourceSectionId && sectionId === "pinned")) {
      return;
    }
    // Shared moves use loaded rows; personal pins can also resolve outside the roster.
    const session = sessionKey
      ? (this.deps.findSidebarMenuSessionByKey(sessionKey) ??
        (sectionId === "pinned"
          ? this.deps.reconciledSidebarZone().sessionRows.get(sessionKey)
          : undefined))
      : undefined;
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
        if (targetSessionKey && targetSessionKey !== session.key) {
          const targetEntry = serializeSidebarEntry({ type: "session", key: targetSessionKey });
          const position =
            this.sidebarZoneDropTarget?.entry === targetEntry
              ? this.sidebarZoneDropTarget.position
              : "before";
          this.writeSidebarEntryAt(
            serializeSidebarEntry({ type: "session", key: session.key }),
            targetEntry,
            position,
          );
        } else {
          this.setPersonalSessionPin(session.key, true);
        }
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
}
