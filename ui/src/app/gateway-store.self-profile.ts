import type { UserProfile, UsersSelfResult } from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { userProfileAvatarUrl } from "../pages/profile/profile-avatar-url.ts";
import type { ApplicationGatewayConnection, ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorReadAccess, hasOperatorSelfReadAccess } from "./operator-access.ts";
import {
  readPresenceEntries,
  resolveSelfPresenceUser,
  sameSelfUser,
  type AuthenticatedUser,
} from "./user-profile.ts";

const FACTORY_PRINCIPAL = /^github:microsoft\.ghe\.com:([1-9][0-9]*)$/u;

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
      .then(({ profile, authenticatedGitHubIdentity }) => {
        if (!isCurrent()) {
          return null;
        }
        const currentSelf = options.getSnapshot().selfUser;
        const currentProfile = currentSelf?.id === profile.id ? currentSelf : null;
        const newerDisplay = currentProfile && currentSelf !== selfAtStart ? currentProfile : null;
        const principal = authenticatedGitHubIdentity
          ? `github:${authenticatedGitHubIdentity.host}:${authenticatedGitHubIdentity.accountId}`
          : undefined;
        const profileName = profile.displayName?.trim() || authenticatedGitHubIdentity?.login;
        const currentName = newerDisplay ? newerDisplay.name : profileName;
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
          name: currentName === principal ? profileName : currentName,
          email: profile.emails[0],
          // Refresh our timestamp fallback without replacing a precise presence/upload revision.
          avatarUrl,
          ...(authenticatedGitHubIdentity ? { authenticatedGitHubIdentity } : {}),
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
    needsRefresh: () => {
      const self = options.getSnapshot().selfUser;
      return (
        !self || FACTORY_PRINCIPAL.test(self.name ?? "") || FACTORY_PRINCIPAL.test(self.email ?? "")
      );
    },
    applyPresence: (payload: unknown) => {
      const snapshot = options.getSnapshot();
      const current = snapshot.selfUser;
      if (snapshot.phase !== "connected") {
        return;
      }
      const presence = resolveSelfPresenceUser(
        readPresenceEntries(payload) ?? [],
        snapshot.client?.instanceId,
      );
      if (!presence) {
        return;
      }
      if (
        hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
        (presence.id !== current?.id ||
          (presence.identity && presence.identity.id !== current.identity?.id))
      ) {
        // Broad readers receive live identity attachment changes through their own presence row.
        selfProfileRequest = null;
        fallbackAvatarUrl = undefined;
        options.publish(presence);
      } else if (presence.id === current?.id) {
        const verified = current.authenticatedGitHubIdentity;
        const principal = verified ? `github:${verified.host}:${verified.accountId}` : undefined;
        const updated = {
          ...current,
          // An omitted presence name clears the display name; profile facts stay canonical.
          name: verified && presence.name === principal ? current.name : presence.name,
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
