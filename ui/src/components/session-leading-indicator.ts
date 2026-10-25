import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { t } from "../i18n/index.ts";
import type { SessionCreatedActor } from "../lib/session-owner.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export function describeSessionState(session: SidebarRecentSession) {
  return [
    !session.isChild && session.forkSource ? t("sessionsView.forkedSession") : "",
    (session.hasActiveRun || session.runningChildCount > 0) && session.unread
      ? t("sessionsView.unread")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function sessionLeadingRun(session: SidebarRecentSession, includeChildren: boolean) {
  const own = session.isRunVisuallyActive ?? session.hasActiveRun;
  const children = includeChildren && session.runningChildCount > 0;
  return children && (!own || session.status === "queued")
    ? "subagents"
    : own
      ? session.status === "queued"
        ? "queued"
        : "active"
      : "none";
}

export function sessionLeadingAvatarIdentities(
  session: SidebarRecentSession,
  owner: SessionCreatedActor | null | undefined,
  hasIcon: boolean,
  trailingState: boolean,
) {
  if (
    hasIcon ||
    session.channelAvatarUrl ||
    (session.isChild && !trailingState) ||
    !owner?.id?.trim()
  ) {
    return [];
  }
  return [
    owner.identity,
    (session.participantCount ?? session.participants?.length) === 1
      ? session.participants?.[0]?.identity
      : undefined,
  ].filter((identity): identity is SessionParticipantIdentity => identity !== undefined);
}
