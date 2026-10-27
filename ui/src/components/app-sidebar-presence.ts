import type { SidebarZoneEntry } from "../app-navigation.ts";
import {
  resolveCurrentSelfUser,
  type AuthenticatedUser,
  type PresencePayload,
} from "../app/user-profile.ts";
import {
  presenceViewerActivity,
  projectPresencePayload,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import type { ContextualSidebar } from "./sidebar-context-state.ts";

export type SidebarPresenceScope = {
  online: boolean;
  sessionKeys: ReadonlySet<string>;
  profileIds: ReadonlySet<string>;
  activityProfileIds: ReadonlySet<string>;
  selfUser?: AuthenticatedUser | null;
  selfInstanceId?: string;
};

type SidebarPresenceHost = {
  navigationView: "sessions" | "online" | "pages";
  contextualSidebar?: ContextualSidebar;
  sessionDataContext?: { gateway: { snapshot: { selfUser?: AuthenticatedUser | null } } };
  sessionData: { presenceInstanceId?: string; presencePayload: PresencePayload | undefined };
  reconciledSidebarZone(): { entries: readonly SidebarZoneEntry[] };
  mountedPresence(): {
    sessionKeys: ReadonlySet<string>;
    activityProfileIds: ReadonlySet<string>;
  };
};

export function sidebarPresenceScope(host: SidebarPresenceHost): SidebarPresenceScope {
  const sessionsVisible = host.navigationView === "sessions" && !host.contextualSidebar;
  // Mounted refs include plugin-delegated lists while excluding collapsed or paged-out rows.
  const { sessionKeys, activityProfileIds } = sessionsVisible
    ? host.mountedPresence()
    : { sessionKeys: new Set<string>(), activityProfileIds: new Set<string>() };
  const profileIds = new Set(activityProfileIds);
  for (const entry of host.reconciledSidebarZone().entries) {
    if (entry.type === "person") {
      profileIds.add(entry.profileId);
    }
  }
  return {
    online: host.navigationView === "online",
    sessionKeys,
    profileIds,
    activityProfileIds,
    selfUser: host.sessionDataContext?.gateway.snapshot.selfUser,
    selfInstanceId: host.sessionData.presenceInstanceId,
  };
}

function person(user: AuthenticatedUser) {
  return [
    user.id,
    user.identity?.type,
    user.identity?.id,
    user.name,
    user.email,
    user.avatarUrl,
    user.isGuest,
  ];
}

export function sidebarPresencePresentation(
  payload: PresencePayload | undefined,
  scope: SidebarPresenceScope,
) {
  const self = resolveCurrentSelfUser({
    snapshotUser: scope.selfUser,
    presenceEntries: payload?.presence,
    presenceInstanceId: scope.selfInstanceId,
  });
  return JSON.stringify([
    scope.online && payload !== undefined,
    self ? [self.id, self.identity?.id] : null,
    projectPresencePayload(payload).users.flatMap((user) => {
      const watched = user.watchedSessions.filter((key) => scope.sessionKeys.has(key));
      const profile = user.identity?.type === "profile" && scope.profileIds.has(user.identity.id);
      const activity =
        user.identity?.type === "profile" && scope.activityProfileIds.has(user.identity.id);
      return scope.online || profile || watched.length
        ? [[person(user), scope.online || activity ? presenceViewerActivity(user) : null, watched]]
        : [];
    }),
  ]);
}

export function sidebarPresenceActivityViewers(
  host: SidebarPresenceHost,
): readonly PresenceViewer[] {
  const scope = sidebarPresenceScope(host);
  return projectPresencePayload(host.sessionData.presencePayload).users.filter(
    (user) =>
      scope.online ||
      (user.identity?.type === "profile" && scope.activityProfileIds.has(user.identity.id)),
  );
}
