import type { SystemPresence } from "../infra/system-presence.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";

export function buildAuthenticatedPresenceUser(params: {
  authenticatedUserId?: string;
  authenticatedUserIsTailscaleProvider?: boolean;
  authenticatedUserIsGuest?: boolean;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    avatarRevision: string;
  };
}): SystemPresence["user"] | undefined {
  if (!params.authenticatedUserProfile) {
    if (!params.authenticatedUserId) {
      return undefined;
    }
    return {
      id: params.authenticatedUserId,
      ...(params.authenticatedUserIsTailscaleProvider ? {} : { email: params.authenticatedUserId }),
    };
  }
  return {
    id: params.authenticatedUserProfile.profileId,
    identity: { type: "profile", id: params.authenticatedUserProfile.profileId },
    ...(params.authenticatedUserIsGuest !== undefined
      ? { isGuest: params.authenticatedUserIsGuest }
      : {}),
    ...(params.authenticatedUserId && !params.authenticatedUserIsTailscaleProvider
      ? { email: params.authenticatedUserId }
      : {}),
    ...(params.authenticatedUserProfile.displayName
      ? { name: params.authenticatedUserProfile.displayName }
      : {}),
    // This authenticated route resolves uploaded avatars first and then the
    // gateway-side Gravatar proxy, so it remains present without an upload.
    avatarUrl: buildControlUiUserAvatarPath(
      params.authenticatedUserProfile.profileId,
      params.authenticatedUserProfile.avatarRevision,
    ),
  };
}
