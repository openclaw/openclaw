import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getResidentUserProfileDisplay } from "../state/user-profile-list.js";
import type { UserProfileDisplay } from "../state/user-profiles.types.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";

export type CurrentUserProfileDisplay =
  | {
      kind: "resolved";
      profileId: string;
      label?: string;
      avatarUrl: string;
      hasUploadedAvatar: boolean;
    }
  | { kind: "unresolved" };

export type CurrentUserProfileDisplayResolver = (senderId: string) => CurrentUserProfileDisplay;

export function resolveCurrentUserProfileDisplay(
  senderId: string,
  readDisplay: (id: string) => UserProfileDisplay | undefined = getResidentUserProfileDisplay,
): CurrentUserProfileDisplay {
  try {
    const profile = readDisplay(senderId);
    if (!profile) {
      return { kind: "unresolved" };
    }
    const label = normalizeOptionalString(profile.displayName);
    return {
      kind: "resolved",
      profileId: profile.id,
      ...(label ? { label } : {}),
      avatarUrl: buildControlUiUserAvatarPath(profile.id, profile.avatarRevision),
      hasUploadedAvatar: profile.hasAvatar,
    };
  } catch {
    // A missing or deleted profile remains unresolved; raw senders never reach this lookup.
    return { kind: "unresolved" };
  }
}
