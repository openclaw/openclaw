import type {
  SessionCreatedActor,
  SessionSharingIdentity,
} from "../../../packages/gateway-protocol/src/index.js";
import type { listProfiles } from "../../state/user-profiles.js";
import { buildControlUiUserAvatarPath } from "../control-ui-contract.js";

export type SharingActorFacts =
  | { state: "present"; actor: SessionSharingIdentity }
  | { state: "unknown" }
  | { state: "absent" };

export function knownSessionIdentities(params: {
  creators: readonly SessionCreatedActor[];
  actor: SharingActorFacts;
  profiles: Awaited<ReturnType<typeof listProfiles>>;
}): SessionSharingIdentity[] {
  const identities = new Map<string, SessionSharingIdentity>();
  const remember = (identity: SessionCreatedActor | null) => {
    if (!identity?.id) {
      return;
    }
    const current = identities.get(identity.id);
    identities.set(identity.id, {
      type: identity.type,
      id: identity.id,
      ...(identity.identity ? { identity: identity.identity } : {}),
      ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
      ...((identity.label ?? current?.label) ? { label: identity.label ?? current?.label } : {}),
    });
  };
  if (params.actor.state === "present") {
    remember(params.actor.actor);
  }
  for (const creator of params.creators) {
    remember(creator);
  }
  for (const profile of params.profiles) {
    remember({
      type: "human",
      id: profile.id,
      identity: { type: "profile", id: profile.id },
      label:
        profile.displayName?.trim() ||
        profile.githubIdentity?.login ||
        profile.emails[0] ||
        profile.id,
      ...(profile.hasAvatar
        ? { avatarUrl: buildControlUiUserAvatarPath(profile.id, profile.updatedAt) }
        : {}),
    });
  }
  return [...identities.values()];
}
