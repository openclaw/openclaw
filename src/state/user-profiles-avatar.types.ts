import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ProfileDisplayRow,
  UserProfile,
  UserProfileAvatarMime,
} from "./user-profiles.types.js";

export type UserProfileAvatar = {
  bytes: Uint8Array;
  mime: UserProfileAvatarMime;
  sha256: string;
  updatedAt: number;
};

export type UserProfileAvatarInspection = {
  profile: UserProfile | undefined;
  hasAvatar: boolean;
  avatar?: Omit<UserProfileAvatar, "bytes"> & { byteLength: number };
  emails: string[];
};

export type UserProfileAvatarRepresentation = {
  canonicalProfileId: string;
  sha256: string;
  mime: UserProfileAvatarMime;
};

export type UserProfileAvatarReadCommand =
  | { type: "userProfiles.avatar.inspect"; profileId: string }
  | {
      type: "userProfiles.avatar.read";
      profileId: string;
      expected: UserProfileAvatarRepresentation;
    };

export type UserProfileAvatarReadReply =
  | { type: "userProfiles.avatar.inspect"; inspection: UserProfileAvatarInspection }
  | { type: "userProfiles.avatar.read"; avatar: UserProfileAvatar | undefined };

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
