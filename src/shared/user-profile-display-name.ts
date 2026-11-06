import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";

/** Presentation only: never persist this fallback into the editable profile name. */
export function userProfileDisplayName(
  profileId: string,
  displayName: string | null | undefined,
  verifiedGitHubLogin?: string | null,
): string | undefined {
  return (
    displayName?.trim() ||
    verifiedGitHubLogin?.trim() ||
    (profileId === GATEWAY_OWNER_PROFILE_ID ? undefined : "Person " + profileId.slice(0, 8))
  );
}
