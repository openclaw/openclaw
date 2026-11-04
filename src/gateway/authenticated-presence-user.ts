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
    // This authenticated route resolves uploaded avatars first and then the
    // gateway-side Gravatar proxy, so it remains present without an upload.
    avatarUrl: buildControlUiUserAvatarPath(
      params.authenticatedUserProfile.profileId,
      params.authenticatedUserProfile.avatarRevision,
    ),
  };
}
