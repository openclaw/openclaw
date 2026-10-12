import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isProfileDisplayRow } from "./user-profile-display-validation.js";
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

export type UserProfileAvatarRepresentation = Pick<UserProfileAvatar, "sha256" | "mime"> & {
  canonicalProfileId: string;
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
  return isRecord(value) && value.kind === "profile-avatar" && isProfileDisplayRow(value.before);
}
