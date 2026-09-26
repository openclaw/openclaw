import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { groupPresenceUsers, presenceUserKey } from "../../../src/shared/presence-user.ts";
import type { PresenceEntry } from "../api/types.ts";
import {
  readPresenceEntries,
  resolveSelfPresenceUser,
  type AuthenticatedUser,
} from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";

export type PresenceViewer = NonNullable<PresenceEntry["user"]> & {
  watchedSessions: readonly string[];
  entries?: readonly PresenceEntry[];
};

// Matches the native Mac's recent-input window for interactive presence.
const PRESENCE_ACTIVE_INPUT_THRESHOLD_SECONDS = 120;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

let cachedPresencePayload: unknown;
let cachedPresenceProjection: ReturnType<typeof groupPresenceUsers> | undefined;

export function projectPresencePayload(value: unknown) {
  if (cachedPresenceProjection && cachedPresencePayload === value) {
    return cachedPresenceProjection;
  }
  cachedPresencePayload = value;
  cachedPresenceProjection = groupPresenceUsers(readPresenceEntries(value) ?? []);
  return cachedPresenceProjection;
}

export function presenceUserLabel(
  user: Pick<PresenceViewer, "id" | "name" | "email">,
  fallbackName = user.id,
) {
  const isSharedOwner = user.id === GATEWAY_OWNER_PROFILE_ID;
  return {
    name: isSharedOwner
      ? t("presence.sharedOwner.name")
      : (user.name ?? user.email ?? fallbackName),
    isSharedOwner,
  };
}

export function presenceViewerLabel(user: Pick<PresenceViewer, "id" | "name" | "email">): string {
  return presenceUserLabel(user).name;
}

export function isPresenceViewerIdle(user: PresenceViewer): boolean {
  const recencies = (user.entries ?? []).flatMap((entry) =>
    entry.lastInputSeconds === undefined ? [] : [entry.lastInputSeconds],
  );
  return (
    recencies.length > 0 &&
    recencies.every((seconds) => seconds > PRESENCE_ACTIVE_INPUT_THRESHOLD_SECONDS)
  );
}

function comparePresenceViewers(a: PresenceViewer, b: PresenceViewer): number {
  const activityOrder = Number(isPresenceViewerIdle(a)) - Number(isPresenceViewerIdle(b));
  if (activityOrder !== 0) {
    return activityOrder;
  }
  const labelA = presenceViewerLabel(a).toLowerCase();
  const labelB = presenceViewerLabel(b).toLowerCase();
  return compareText(labelA, labelB) || compareText(presenceUserKey(a), presenceUserKey(b));
}

export function presenceMatchesProfile(
  user: PresenceViewer,
  identity?: SessionParticipantIdentity,
): boolean {
  return identity?.type === "profile" && user.identity?.id === identity.id;
}

export function projectPresenceViewers(
  value: unknown,
  selfUser?: AuthenticatedUser | null,
  selfInstanceId?: string,
  sessionKey?: string,
  excludeIdentities: readonly SessionParticipantIdentity[] = [],
): readonly PresenceViewer[] {
  const self =
    selfUser ?? resolveSelfPresenceUser(readPresenceEntries(value) ?? [], selfInstanceId);
  const selfKey = self ? presenceUserKey(self) : undefined;
  return projectPresencePayload(value).users.filter(
    (user) =>
      presenceUserKey(user) !== selfKey &&
      !excludeIdentities.some((identity) => presenceMatchesProfile(user, identity)) &&
      (sessionKey === undefined || user.watchedSessions.includes(sessionKey)),
  );
}

export function projectOnlinePresenceViewers(
  value: unknown,
  authenticatedSelfUser?: AuthenticatedUser | null,
  selfInstanceId?: string,
): readonly PresenceViewer[] {
  return projectPresenceViewers(value, authenticatedSelfUser, selfInstanceId).toSorted(
    comparePresenceViewers,
  );
}

export function hasSessionPresenceViewers(
  value: unknown,
  selfUser: AuthenticatedUser | null | undefined,
  selfInstanceId: string | undefined,
  sessionKey: string,
): boolean {
  return projectPresenceViewers(value, selfUser, selfInstanceId, sessionKey).length > 0;
}

export function hasMultiplePresenceIdentities(value: unknown): boolean {
  return projectPresencePayload(value).users.length >= 2;
}
