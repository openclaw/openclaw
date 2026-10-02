import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  UserProfile,
  UsersListResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

/** Follow only merge edges returned by the authorized profile directory. */
export function canonicalPersonProfile(
  profiles: readonly UserProfile[],
  profileId: string,
): UserProfile | null {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const visited = new Set<string>();
  let profile = byId.get(profileId);
  while (profile?.mergedInto && !visited.has(profile.id)) {
    visited.add(profile.id);
    profile = byId.get(profile.mergedInto);
  }
  return profile && !profile.mergedInto ? profile : null;
}

export function canReadPersonProfile(
  gateway: Pick<ApplicationGateway, "snapshot">,
  profileId: string,
): boolean {
  const snapshot = gateway.snapshot;
  const self = snapshot.selfUser?.identity;
  return (
    canCallGatewayMethod(snapshot, "users.list", "operator.read") ||
    (self?.type === "profile" &&
      self.id === profileId &&
      canCallGatewayMethod(snapshot, "users.self", "operator.sessions.read"))
  );
}

/** Self reads stay with the connection owner; other people require broad directory access. */
export async function readPersonProfile(
  gateway: Pick<ApplicationGateway, "snapshot" | "loadSelfProfile">,
  profileId: string,
): Promise<UserProfile | null> {
  if (!canReadPersonProfile(gateway, profileId)) {
    return null;
  }
  const snapshot = gateway.snapshot;
  if (
    snapshot.selfUser?.identity?.id === profileId &&
    canCallGatewayMethod(snapshot, "users.self", "operator.sessions.read")
  ) {
    return gateway.loadSelfProfile();
  }
  if (!snapshot.client || !canCallGatewayMethod(snapshot, "users.list", "operator.read")) {
    return null;
  }
  const result = await snapshot.client.request<UsersListResult>("users.list", {});
  return canonicalPersonProfile(result.profiles, profileId);
}

/** Owns canonical person facts, their profile-change invalidation, and transport-scoped reads. */
export function observePersonProfile(
  gateway: Pick<
    ApplicationGateway,
    "snapshot" | "loadSelfProfile" | "subscribeEvents" | "connectionRevision"
  >,
  profileId: string,
  changed: () => void,
) {
  const { client, hello } = gateway.snapshot;
  const revision = gateway.connectionRevision;
  const selfId = gateway.snapshot.selfUser?.identity?.id;
  let disposed = false;
  let generation = 0;
  const isCurrent = () =>
    !disposed &&
    client === gateway.snapshot.client &&
    hello === gateway.snapshot.hello &&
    revision === gateway.connectionRevision &&
    selfId === gateway.snapshot.selfUser?.identity?.id &&
    canReadPersonProfile(gateway, profileId);
  let profile: UserProfile | null | undefined = isCurrent() ? undefined : null;
  const refresh = async (notifyLoading = true) => {
    if (!isCurrent()) {
      return;
    }
    const request = ++generation;
    profile = undefined;
    if (notifyLoading) {
      changed();
    }
    const result = await readPersonProfile(gateway, profileId).catch(() => null);
    if (request !== generation || !isCurrent()) {
      return;
    }
    profile = result;
    changed();
  };
  const stop = gateway.subscribeEvents((event) => {
    if (
      event.event === "sessions.changed" &&
      asOptionalRecord(event.payload)?.reason === "profile-identity"
    ) {
      void refresh();
    }
  });
  if (profile === undefined) {
    void refresh(false);
  }
  return {
    gateway,
    profileId,
    get profile() {
      return isCurrent() ? profile : null;
    },
    isCurrent,
    dispose() {
      disposed = true;
      generation += 1;
      stop();
    },
  };
}
