import { Buffer } from "node:buffer";
import type { UserProfile } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";

export const TEAM_SCALE_SELF_INSTANCE_ID = "team-scale-self";

function personId(index: number) {
  return `team-person-${String(index + 1).padStart(3, "0")}`;
}

export function createTeamScalePeople(
  count: number,
  now: number,
  options: { avatars?: boolean; sharing?: boolean } = {},
) {
  const avatars = options.avatars ?? false;
  const people: ControlUiMockPresenceUser[] = Array.from({ length: count }, (_, index) => ({
    id: personId(index),
    identity: { type: "profile", id: personId(index) },
    self: index === 0,
    name: `Fixture person ${String(index + 1).padStart(3, "0")}`,
    email: `person-${index + 1}@example.test`,
    ...(avatars ? { avatarUrl: `/api/users/${personId(index)}/avatar?v=${now}` } : {}),
    instanceId: index === 0 ? TEAM_SCALE_SELF_INSTANCE_ID : `team-client-${index + 1}`,
    mode: "webchat",
    platform: "MacIntel",
    deviceFamily: "Mac",
    timeZone: "America/Los_Angeles",
    ts: now,
    onlineSince: now - 3_600_000 - index * 60_000,
    lastActivityAt: now - index * 1_000,
    lastInputSeconds: index,
  }));
  const profiles: UserProfile[] = people.map((person) => ({
    id: person.id,
    displayName: person.name ?? null,
    emails: person.email ? [person.email] : [],
    avatarMime: avatars ? "image/png" : null,
    hasAvatar: avatars,
    githubIdentity: null,
    mergedInto: null,
    createdAt: now - 86_400_000,
    updatedAt: now,
  }));
  const sharingPeople = options.sharing ? people.slice(34, 82) : [];
  const avatarAssets = new Map<string, { body: Buffer; contentType: string }>();
  if (options.sharing) {
    const asset = {
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAALElEQVR4nO3NMQkAAAwDsEqv9Jko7AnkT9L+EIvFYrFYLBaLxWKxWCwWi3cOaSNAW3upfawAAAAASUVORK5CYII=",
        "base64",
      ),
    };
    for (const profile of profiles.slice(34, 82)) {
      profile.hasAvatar = true;
      profile.avatarMime = "image/png";
      avatarAssets.set(`/api/users/${profile.id}/avatar`, asset);
    }
  }
  const sharingMembers = options.sharing
    ? {
        role: "admin",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        members: sharingPeople.slice(0, 6).map((person) => ({
          identityId: person.id,
          addedBy: people[0]!.id,
          addedAt: now,
        })),
        identities: sharingPeople.map((person) => ({
          id: person.id,
          type: "human",
          identity: person.identity,
          label: person.name,
          avatarUrl: `/api/users/${person.id}/avatar?v=${now}`,
        })),
      }
    : undefined;
  return { people, profiles, avatarAssets, sharingMembers };
}
