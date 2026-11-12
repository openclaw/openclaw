import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";

/** Presentation only: sign-in aliases are not necessarily email addresses. */
export function isUserProfileEmailAddress(alias: string): boolean {
  return /^[^\s@/:]+@[^\s@/:]+$/u.test(alias);
}

/** Older profiles inferred their name from an issuer-qualified proxy subject. */
export function userProfileEditableDisplayName(name: string | null | undefined): string | null {
  // A deliberately chosen name with this same opaque shape is also hidden; the
  // saved name and authentication binding remain intact and can be edited.
  return name && !/^https?:\/\/\S+#\S+$/iu.test(name.trim()) ? name : null;
}

/** Presentation only: never persist this fallback into the editable profile name. */
export function userProfileDisplayName(
  profileId: string,
  displayName: string | null | undefined,
  verifiedGitHubLogin?: string | null,
): string | undefined {
  return (
    userProfileEditableDisplayName(displayName)?.trim() ||
    verifiedGitHubLogin?.trim() ||
    (profileId === GATEWAY_OWNER_PROFILE_ID ? undefined : "Person " + profileId.slice(0, 8))
  );
}
