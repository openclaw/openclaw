import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionParticipantIdentityKey } from "../../lib/chat/sender-label.ts";
import type { IdentityAvatarInput } from "../../lib/identity-avatar.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";

export type ChatMobilePeopleMention = UsersMentionableResult["users"][number];

export type ChatMobilePerson = {
  key: string;
  sender: IdentityAvatarInput;
  label: string;
  firstName: string;
  viewing: boolean;
  mention?: ChatMobilePeopleMention;
};

export type ChatMobilePeople = {
  header: readonly ChatMobilePerson[];
  viewers: readonly ChatMobilePerson[];
  creator?: ChatMobilePerson;
  owner?: ChatMobilePerson;
  participants: readonly ChatMobilePerson[];
  unlistedParticipantCount: number;
  participantsComplete: boolean;
};

export type ChatMobilePeopleInput = {
  session: Pick<
    GatewaySessionRow,
    "createdActor" | "owner" | "participants" | "expandedParticipants" | "participantCount"
  >;
  /** The pane key used by the native viewer-presence owner, not a row alias. */
  sessionKey: string;
  /** Unfiltered native presence projection: include self, owner and participants. */
  viewers: readonly PresenceViewer[];
  /** Current composer directory results, never membership-derived permissions. */
  mentionableUsers: readonly ChatMobilePeopleMention[];
};

/** Presentation only. Session, presence and composer owners retain their lifecycles. */
export function projectChatMobilePeople(input: ChatMobilePeopleInput): ChatMobilePeople {
  const mentions = new Map(input.mentionableUsers.map((entry) => [entry.profileId, entry]));
  const people = new Map<string, ChatMobilePerson>();
  const viewingKeys = new Set<string>();
  const viewerKey = (viewer: PresenceViewer) =>
    viewer.identity
      ? sessionParticipantIdentityKey(viewer.identity)
      : JSON.stringify(["presence", viewer.id]);
  const viewers = input.viewers.filter((viewer) =>
    viewer.watchedSessions.includes(input.sessionKey),
  );
  for (const viewer of viewers) {
    viewingKeys.add(viewerKey(viewer));
  }

  function person(key: string, sender: IdentityAvatarInput): ChatMobilePerson {
    const existing = people.get(key);
    if (existing) {
      return existing;
    }
    const label = sender.name?.trim() || sender.id || "";
    const result: ChatMobilePerson = {
      key,
      sender,
      label,
      firstName: label.split(/\s+/u)[0] ?? label,
      viewing: viewingKeys.has(key),
      mention: sender.identity?.type === "profile" ? mentions.get(sender.identity.id) : undefined,
    };
    people.set(key, result);
    return result;
  }

  function actor(
    value: GatewaySessionRow["createdActor"],
    role: "creator" | "owner",
  ): ChatMobilePerson | undefined {
    if (!value) {
      return undefined;
    }
    // An untyped actor id is not proof of a profile identity. Missing ids also
    // cannot establish that two role records describe the same person.
    const key = value.identity
      ? sessionParticipantIdentityKey(value.identity)
      : JSON.stringify(["actor", value.type, value.id ?? null, value.id ? null : role]);
    return person(key, {
      identity: value.identity,
      id: value.id ?? value.identity?.id,
      name: value.label || value.id || value.identity?.id || value.type,
      profileAvatarUrl: value.avatarUrl,
    });
  }

  const creator = actor(input.session.createdActor, "creator");
  const owner = actor(input.session.owner?.actor, "owner");
  const roleKeys = new Set([creator?.key, owner?.key]);
  const participants = new Map<string, ChatMobilePerson>();
  const recordedParticipantKeys = new Set<string>();
  for (const participant of input.session.expandedParticipants ??
    input.session.participants ??
    []) {
    const key = sessionParticipantIdentityKey(participant.identity);
    recordedParticipantKeys.add(key);
    const value = person(key, {
      identity: participant.identity,
      id: participant.identity.id,
      name: participant.label,
      profileAvatarUrl: participant.avatarUrl,
    });
    if (!roleKeys.has(key)) {
      participants.set(key, value);
    }
  }
  const currentViewers = new Map<string, ChatMobilePerson>();
  for (const viewer of viewers) {
    const key = viewerKey(viewer);
    currentViewers.set(
      key,
      person(key, {
        identity: viewer.identity,
        id: viewer.id,
        name: viewer.name ?? viewer.email,
        profileAvatarUrl: viewer.avatarUrl,
      }),
    );
  }
  const header = new Map<string, ChatMobilePerson>();
  for (const value of [creator, owner, ...participants.values(), ...currentViewers.values()]) {
    if (value?.viewing) {
      header.set(value.key, value);
    }
  }
  return {
    header: currentViewers.size > 1 ? [...header.values()] : [],
    viewers: [...currentViewers.values()],
    creator: creator?.key === owner?.key ? undefined : creator,
    owner,
    participants: [...participants.values()],
    participantsComplete:
      input.session.participantCount !== undefined &&
      input.session.participantCount <= recordedParticipantKeys.size,
    unlistedParticipantCount: Math.max(
      0,
      (input.session.participantCount ?? 0) - recordedParticipantKeys.size,
    ),
  };
}
