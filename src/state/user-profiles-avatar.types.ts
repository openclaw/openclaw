import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isProfileDisplayRow } from "./user-profile-list.js";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export type UserProfileAvatarAdmission = { kind: "profile-avatar"; before: ProfileDisplayRow };

export function isUserProfileAvatarAdmission(value: unknown): value is UserProfileAvatarAdmission {
  return isRecord(value) && value.kind === "profile-avatar" && isProfileDisplayRow(value.before);
}
