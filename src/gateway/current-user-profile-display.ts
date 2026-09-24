import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getUserProfileDisplay } from "../state/user-profile-list.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";
import type { CurrentUserProfileDisplay } from "./current-user-profile-display.types.js";

export function resolveCurrentUserProfileDisplay(senderId: string): CurrentUserProfileDisplay {
  try {
    const profile = getUserProfileDisplay(senderId);
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
