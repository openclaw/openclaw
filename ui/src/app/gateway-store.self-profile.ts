import type { UserProfile, UsersSelfResult } from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { userProfileAvatarUrl } from "../pages/profile/profile-avatar-url.ts";
import type { ApplicationGatewayConnection, ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorSelfReadAccess } from "./operator-access.ts";
import {
  readPresenceEntries,
  resolveSelfPresenceUser,
  sameSelfUser,
  type AuthenticatedUser,
} from "./user-profile.ts";

export function createGatewaySelfProfile(options: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  getConnection: () => ApplicationGatewayConnection;
  publish: (selfUser: AuthenticatedUser | null) => void;
  resourceBasePath?: string;
}) {
  let selfProfileRequest: Promise<UserProfile | null> | null = null;
  let fallbackAvatarUrl: string | undefined;
  const loadSelfProfile = (): Promise<UserProfile | null> => {
    const requestClient = options.getSnapshot().client;
    const hello = options.getSnapshot().hello;
    if (
      !requestClient ||
      !hello ||
      options.getSnapshot().phase !== "connected" ||
      !hasOperatorSelfReadAccess(hello.auth ?? null)
    ) {
      return Promise.resolve(null);
    }
    if (selfProfileRequest) {
      return selfProfileRequest;
    }
    const selfAtStart = options.getSnapshot().selfUser;
    const isCurrent = (): boolean =>
      options.getSnapshot().client === requestClient &&
      options.getSnapshot().hello === hello &&
      options.getSnapshot().phase === "connected" &&
      selfProfileRequest === request;
    const request: Promise<UserProfile | null> = requestClient
      .request<UsersSelfResult>("users.self", {})
      .then(({ profile }) => {
        if (!isCurrent()) {
          return null;
        }
        const currentSelf = options.getSnapshot().selfUser;
        const currentProfile = currentSelf?.id === profile.id ? currentSelf : null;
        const newerDisplay = currentProfile && currentSelf !== selfAtStart ? currentProfile : null;
        const presence = resolveSelfPresenceUser(
          readPresenceEntries(hello.snapshot) ?? [],
          requestClient.instanceId,
        );
        const previousAvatar =
          currentProfile?.avatarUrl ??
          (presence?.id === profile.id ? presence.avatarUrl : undefined);
        const fallback =
          userProfileAvatarUrl(
            options.getConnection().gatewayUrl,
            profile.id,
            profile.updatedAt,
            options.resourceBasePath,
          ) ?? undefined;
        const avatarUrl =
          previousAvatar && previousAvatar !== fallbackAvatarUrl ? previousAvatar : fallback;
        fallbackAvatarUrl = fallback;
        const selfUser = {
          id: profile.id,
          identity: { type: "profile" as const, id: profile.id },
          name: newerDisplay ? newerDisplay.name : (profile.displayName ?? undefined),
          email: profile.emails[0],
          // Refresh our timestamp fallback without replacing a precise presence/upload revision.
          avatarUrl,
        };
        if (!sameSelfUser(options.getSnapshot().selfUser, selfUser)) {
          options.publish(selfUser);
        }
        // Publishing identity can synchronously stop or replace the connection.
        return isCurrent() ? profile : null;
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return null;
        }
        if (error instanceof GatewayRequestError && error.code === "FORBIDDEN") {
          options.publish(null);
          return null;
        }
        throw error;
      })
      .finally(() => {
        if (selfProfileRequest === request) {
          selfProfileRequest = null;
        }
      });
    selfProfileRequest = request;
    return request;
  };
  return {
    load: loadSelfProfile,
    applyPresence: (payload: unknown) => {
      const snapshot = options.getSnapshot();
      const current = snapshot.selfUser;
      if (snapshot.phase !== "connected" || !current) {
        return;
      }
      const presence = resolveSelfPresenceUser(
        readPresenceEntries(payload) ?? [],
        snapshot.client?.instanceId,
      );
      if (presence?.id === current.id) {
        const updated = {
          ...current,
          // An omitted presence name clears the display name; profile facts stay canonical.
          name: presence.name,
          avatarUrl: presence.avatarUrl ?? current.avatarUrl,
        };
        if (!sameSelfUser(current, updated)) {
          options.publish(updated);
        }
      }
    },
    invalidate: () => {
      selfProfileRequest = null;
      if (options.getSnapshot().phase !== "connected") {
        fallbackAvatarUrl = undefined;
      }
    },
  };
}
