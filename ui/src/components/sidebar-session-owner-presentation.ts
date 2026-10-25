import { presenceMatchesProfile, projectPresencePayload } from "../lib/presence-users.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** Capture and live rows share the same avatar suppression and attribution rules. */
export function sidebarSessionOwnerPresentation(
  host: Pick<
    SessionListHost,
    | "sessionsStatusFilter"
    | "sessionOwnershipVisibility"
    | "sessionData"
    | "sessionsGrouping"
    | "sessionDataContext"
    | "sessionInvolvingMeFilterActive"
    | "sessionOwnerFilterId"
    | "sidebarAgentsMode"
  >,
  row: SidebarRecentSession,
) {
  if (row.snapshot) {
    return {
      owner: row.snapshot.owner ?? null,
      attribution: row.snapshot.attribution ?? "created",
      ownerViewing: row.snapshot.ownerViewing,
    };
  }
  const attribution: "archived" | "owned" | "created" =
    host.sessionsStatusFilter === "archived"
      ? "archived"
      : row.owner?.assignedAt !== undefined
        ? "owned"
        : "created";
  const actor = host.sessionOwnershipVisibility.avatars
    ? attribution === "archived"
      ? row.archivedBy
      : row.owner?.actor
    : undefined;
  const ownerViewing =
    actor?.identity?.type === "profile"
      ? projectPresencePayload(host.sessionData.presencePayload).users.some(
          (user) =>
            presenceMatchesProfile(user, actor.identity) && user.watchedSessions.includes(row.key),
        )
      : undefined;
  const repeatedBySection =
    host.sessionsGrouping === "person" && !row.pinned && attribution !== "archived";
  const self = host.sessionDataContext?.gateway.snapshot.selfUser;
  const repeatedByFilter =
    attribution !== "archived" &&
    actor?.identity?.type === "profile" &&
    actor.identity.id === (self?.identity?.id ?? self?.id) &&
    (host.sessionInvolvingMeFilterActive || host.sessionOwnerFilterId === actor.id) &&
    (row.participantCount ?? row.participants?.length ?? 0) === 0;
  return {
    owner:
      repeatedByFilter ||
      (host.sidebarAgentsMode !== "roster" && repeatedBySection && ownerViewing !== true)
        ? null
        : (actor ?? null),
    attribution,
    ownerViewing,
  };
}
