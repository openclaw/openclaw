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

export type SidebarPresenceScope = {
  online: boolean;
  sessionKeys: ReadonlySet<string>;
  profileIds: ReadonlySet<string>;
  activityProfileIds: ReadonlySet<string>;
  selfUser?: AuthenticatedUser | null;
  selfInstanceId?: string;
};

function person(user: AuthenticatedUser) {
  return [user.id, user.identity?.type, user.identity?.id, user.name, user.email, user.avatarUrl];
}

function presentation(payload: PresencePayload | undefined, scope: SidebarPresenceScope) {
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

export function sameSidebarPresence(
  previous: PresencePayload | undefined,
  next: PresencePayload | undefined,
  scope: SidebarPresenceScope,
): boolean {
  return previous === next || presentation(previous, scope) === presentation(next, scope);
}

export function sidebarPresenceActivityViewers(
  payload: PresencePayload | undefined,
  scope: SidebarPresenceScope,
): readonly PresenceViewer[] {
  return projectPresencePayload(payload).users.filter(
    (user) =>
      scope.online ||
      (user.identity?.type === "profile" && scope.activityProfileIds.has(user.identity.id)),
  );
}
