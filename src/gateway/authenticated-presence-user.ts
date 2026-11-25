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
    const id = params.authenticatedUserId;
    // An email principal is private until a canonical profile is ready.
    // Tailscale's provider-qualified login is a public handle, not an email.
    return id && (params.authenticatedUserIsTailscaleProvider || !id.includes("@"))
      ? { id }
      : undefined;
  }
  return {
    id: params.authenticatedUserProfile.profileId,
    identity: { type: "profile", id: params.authenticatedUserProfile.profileId },
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
