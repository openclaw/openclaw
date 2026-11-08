import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { runSessionNavigationAction } from "../lib/sessions/session-menu-navigation.ts";
import {
  storeSidebarSessionStatusFilter,
  storeSidebarSessionsGrouping,
  storeSidebarSessionsShowCron,
  storeSidebarSessionsShowPreview,
  storeSidebarSessionsShowSystem,
  type SidebarRecentSession,
  type SidebarSessionMutationScope,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";
import type { SessionOrganizer } from "./session-organizer.ts";

type SidebarSessionAction = Exclude<
  SessionMenuAction,
  {
    kind:
      | "open-pr"
      | Parameters<typeof runSessionNavigationAction>[0]
      | "open-in"
      | "move-session"
      | "plugin";
  }
>;

// Pending work is scoped to the organizer and Gateway client, and loaded only with menus.
const pendingNestedSessions = new WeakMap<
  SessionOrganizer,
  WeakMap<SidebarSessionMutationScope["client"], Set<string>>
>();

export function isCreatingNestedSession(
  organizer: SessionOrganizer,
  client: SidebarSessionMutationScope["client"] | null | undefined,
  key: string,
): boolean {
  return Boolean(client && pendingNestedSessions.get(organizer)?.get(client)?.has(key));
}

export function createNestedSession(
  organizer: SessionOrganizer,
  session: SidebarRecentSession,
): Promise<void> {
  let pendingByClient = pendingNestedSessions.get(organizer);
  if (!pendingByClient) {
    pendingByClient = new WeakMap();
    pendingNestedSessions.set(organizer, pendingByClient);
  }
  const clients = pendingByClient;
  return organizer.runOperation(async (operations, scope) => {
    let pending = clients.get(scope.client);
    if (!pending) {
      pending = new Set();
      clients.set(scope.client, pending);
    }
    if (pending.has(session.key)) {
      return;
    }
    pending.add(session.key);
    organizer.notify();
    try {
      await operations.createChildSession(organizer.deps, session, scope, { fork: false });
    } finally {
      pending.delete(session.key);
      organizer.notify();
    }
  });
}

export async function runSessionAction(
  organizer: SessionOrganizer,
  session: SidebarRecentSession,
  action: SidebarSessionAction,
): Promise<unknown> {
  switch (action.kind) {
    case "toggle-pin":
      return organizer.setPersonalSessionPin(
        session.key,
        !organizer.isPersonalSessionPin(session.key),
      );
    case "toggle-unread":
      return session.subagentSummary?.unreadHiddenRuns?.length
        ? runBatchSessionAction(organizer, action, [session], true)
        : organizer.patchSession(session, { unread: !session.unread }, { sessionScope: true });
    case "set-color":
      return organizer.patchSession(session, { color: action.color });
    case "set-icon":
      return organizer.patchSession(session, { icon: action.icon });
    case "set-communication":
      return organizer.patchSession(session, { communication: action.communication });
    case "reset-appearance":
      return organizer.patchSession(session, { icon: null, color: null });
    case "toggle-involving-me": {
      const hidden = !session.hiddenFromInvolvingMe;
      return organizer.runOperation((operations, scope) =>
        operations.setSessionInvolvement(organizer.deps, session, hidden, scope),
      );
    }
    case "move-to-top-level":
      return organizer.promoteSession(session);
    case "move-to-group":
      if (action.category === null || session.category !== action.category) {
        return organizer.assignSessionCategory(session, action.category);
      }
      return undefined;
    case "new-group":
      return createSessionGroup(organizer, [session]);
    case "wake":
      return organizer.patchSession(session, { snoozedUntil: null }, { sessionScope: true });
    case "toggle-archived":
      return session.archived
        ? organizer.patchSession(session, { archived: false }, { sessionScope: true })
        : organizer.archiveSessionWithUndo(session);
    default:
      return organizer.runOperation(
        (operations, scope) => {
          switch (action.kind) {
            case "rename":
              return operations.renameSession(organizer.deps, session, scope);
            case "assign-owner":
              return operations.assignSessionOwner(organizer.deps, session, action.owner, scope);
            case "fork":
              return operations.createChildSession(organizer.deps, session, scope, { fork: true });
            case "snooze":
              return operations.snoozeSessionWithUndo(organizer.deps, session, action, scope);
            case "stop-cloud-worker":
              return operations.stopCloudWorker(organizer.deps, session, scope);
            case "delete":
              // Only the sidebar offers the delete-confirm opt-out.
              return operations.deleteSession(organizer.deps, session, scope, { offerSkip: true });
            default:
              return action satisfies never;
          }
        },
        action.kind === "rename" || action.kind === "delete",
      );
  }
}

export async function runBatchSessionAction(
  organizer: SessionOrganizer,
  action: SessionMenuAction,
  rows: SidebarRecentSession[],
  allUnread: boolean,
): Promise<void> {
  if (action.kind === "new-group") {
    await createSessionGroup(organizer, rows);
    return;
  }
  await organizer.runOperation(
    async (operations, scope) => {
      const moved = await operations.runBatchSessionAction(
        organizer.deps,
        action,
        rows,
        allUnread,
        scope,
      );
      if (action.kind === "move-to-group" && moved && moved.length) {
        organizer.revealSessionGroup(action.category, scope);
      }
    },
    action.kind === "toggle-archived" || action.kind === "delete",
  );
}

/** Preparation failures belong to the same scope as the requested dialog. */
async function runDialog(
  organizer: SessionOrganizer,
  scope: SidebarSessionMutationScope,
  run: () => Promise<void>,
) {
  try {
    await run();
  } catch (error) {
    organizer.deps.sessionData.publishSessionMutationError(scope, error);
  }
}

export function createSessionGroup(
  organizer: SessionOrganizer,
  sessions: readonly SidebarRecentSession[] = [],
): Promise<void> {
  return organizer.createSessionGroup(sessions);
}

export async function renameSessionGroupFromMenu(
  organizer: SessionOrganizer,
  group: string,
): Promise<void> {
  const scope = organizer.deps.sessionData.beginSessionMutation();
  if (!scope) {
    return;
  }
  const signal = organizer.deps.sessionData.sessionDraftSignal;
  await runDialog(organizer, scope, async () => {
    const { renameSessionGroupDialog } =
      await import("./session-organizer-group-dialogs.runtime.ts");
    await renameSessionGroupDialog(organizer.deps, scope, signal, group, (next) => {
      const from = `category:${group}`;
      if (organizer.collapsedSessionSections.has(from)) {
        const collapsed = new Set(organizer.collapsedSessionSections);
        collapsed.delete(from);
        collapsed.add(`category:${next}`);
        organizer.saveCollapsedSessionSections(collapsed);
      }
      organizer.notify();
    });
  });
}

export function deleteSessionGroupFromMenu(
  organizer: SessionOrganizer,
  group: string,
): Promise<void> {
  return organizer.runOperation(async (operations, scope) => {
    if (!(await operations.deleteSessionGroup(organizer.deps, group, scope))) {
      return;
    }
    const collapsed = new Set(organizer.collapsedSessionSections);
    collapsed.delete(`category:${group}`);
    organizer.saveCollapsedSessionSections(collapsed);
  });
}

export async function editSessionGroupDefaults(
  organizer: SessionOrganizer,
  group: string,
): Promise<void> {
  const scope = organizer.deps.sessionData.beginSessionMutation();
  if (!scope) {
    return;
  }
  await runDialog(organizer, scope, async () => {
    const { editSessionGroupDefaultsDialog } =
      await import("./session-organizer-group-dialogs.runtime.ts");
    await editSessionGroupDefaultsDialog(organizer.deps, scope, group);
  });
}

export function setSessionsGrouping(
  organizer: SessionOrganizer,
  grouping: SidebarSessionsGrouping,
) {
  organizer.clearRevealedCreatedGroup();
  if (organizer.deps.sessionsGrouping !== grouping) {
    organizer.deps.releaseSidebarSnapshot();
  }
  organizer.deps.sessionsGrouping = grouping;
  storeSidebarSessionsGrouping(grouping);
  organizer.notify();
}

export function setSessionsShowCron(organizer: SessionOrganizer, show: boolean) {
  organizer.deps.sessionsShowCron = show;
  storeSidebarSessionsShowCron(show);
  organizer.notify();
}

export function setSessionsShowPreview(organizer: SessionOrganizer, show: boolean) {
  organizer.deps.sessionsShowPreview = show;
  storeSidebarSessionsShowPreview(show);
  organizer.notify();
}

export function setSessionsShowSystem(organizer: SessionOrganizer, show: boolean) {
  organizer.deps.sessionsShowSystem = show;
  storeSidebarSessionsShowSystem(show);
  organizer.notify();
}

export function setSessionsStatusFilter(
  organizer: SessionOrganizer,
  statusFilter: SidebarSessionStatusFilter,
) {
  if (statusFilter === organizer.deps.sessionsStatusFilter) {
    return;
  }
  organizer.deps.sessionsStatusFilter = statusFilter;
  organizer.deps.clearSessionSelection();
  organizer.deps.sessionData.resetSessionList();
  storeSidebarSessionStatusFilter(statusFilter);
  void organizer.deps.sessionData.refreshSidebarSessions();
  organizer.notify();
}
