import type { AuthenticatedUser } from "../../../app/user-profile.ts";
import { projectSessionPeople } from "../chat-mobile-people.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

export function resolveDetailsSession(details: ChatDetailsProps | undefined) {
  const selected = details?.selectedSession;
  const cached = !details?.sessionFactsReady && details?.cachedDetails?.session;
  return selected && cached ? { ...selected, ...cached } : selected;
}

export function hasDesktopDetailsPeople(
  details: ChatDetailsProps | undefined,
  viewer: AuthenticatedUser["identity"],
  session = resolveDetailsSession(details),
  people = projectSessionPeople(session, details?.sharing),
) {
  const creator = session?.createdActor;
  const owner = session?.owner?.actor;
  const listed = (session?.expandedParticipants ?? session?.participants ?? []).length;
  const partial = (session?.participantCount ?? 0) > listed;
  // Do not hide an attribution or an incomplete participant list before live facts settle.
  const only = people.length === 1 ? people[0]?.identity : undefined;
  return Boolean(
    (people.length || partial || creator?.label || creator?.id || owner) &&
    !(
      viewer &&
      details?.sessionFactsReady &&
      !partial &&
      (!owner || owner.identity) &&
      (!creator || creator.identity) &&
      only?.type === viewer.type &&
      only.id === viewer.id
    ),
  );
}
