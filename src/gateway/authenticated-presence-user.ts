import type { SystemPresence } from "../infra/system-presence.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";

export function buildAuthenticatedPresenceUser(params: {
  authenticatedUserId?: string;
  authenticatedUserIsTailscaleProvider?: boolean;
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
    ...(params.authenticatedUserId && !params.authenticatedUserIsTailscaleProvider
      ? { email: params.authenticatedUserId }
      : {}),
    ...(params.authenticatedUserProfile.displayName
      ? { name: params.authenticatedUserProfile.displayName }
      : {}),
    // The authenticated profile route owns upload, verified GitHub and Gravatar
    // precedence, so every self/presence surface uses the same photo.
    avatarUrl: buildControlUiUserAvatarPath(
      params.authenticatedUserProfile.profileId,
      params.authenticatedUserProfile.avatarRevision,
    ),
  };
}
