import {
  resolveCurrentSelfUser,
  type AuthenticatedUser,
  type PresencePayload,
} from "../../app/user-profile.ts";
import { projectPresencePayload } from "../../lib/presence-users.ts";

type ChatPresenceScope = {
  sessionKey: string;
  selfUser?: AuthenticatedUser | null;
  selfInstanceId?: string;
};

function personPresentation(user: AuthenticatedUser | null) {
  return user
    ? [user.id, user.identity?.type, user.identity?.id, user.name, user.email, user.avatarUrl]
    : null;
}

function chatPresencePresentation(payload: PresencePayload | undefined, scope: ChatPresenceScope) {
  const { users } = projectPresencePayload(payload);
  const self = resolveCurrentSelfUser({
    snapshotUser: scope.selfUser,
    presenceEntries: payload?.presence,
    presenceInstanceId: scope.selfInstanceId,
  });
  return JSON.stringify([
    users.length >= 2,
    personPresentation(self),
    // Include the owner and self: their watching state also controls header attribution.
    // Device/activity details belong to the separately subscribed person hovercards.
    users.filter((user) => user.watchedSessions.includes(scope.sessionKey)).map(personPresentation),
  ]);
}

export function sameChatPanePresence(
  previous: PresencePayload | undefined,
  next: PresencePayload | undefined,
  scope: ChatPresenceScope,
): boolean {
  return (
    previous === next ||
    chatPresencePresentation(previous, scope) === chatPresencePresentation(next, scope)
  );
}
