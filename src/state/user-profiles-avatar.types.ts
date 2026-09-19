import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export type UserProfileAvatarAdmission = { kind: "profile-avatar"; before: ProfileDisplayRow };

export function isUserProfileAvatarAdmission(value: unknown): value is UserProfileAvatarAdmission {
  if (!isRecord(value) || value.kind !== "profile-avatar" || !isRecord(value.before)) {
    return false;
  }
  const row = value.before;
  return (
    typeof row.id === "string" &&
    typeof row.updated_at === "number" &&
    (row.has_avatar === 0 || row.has_avatar === 1) &&
    ["display_name", "avatar_mime", "avatar_sha256", "merged_into"].every(
      (key) => row[key] === null || typeof row[key] === "string",
    ) &&
    (row.role === undefined || row.role === null || typeof row.role === "string")
  );
}
