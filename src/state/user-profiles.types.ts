import type { SqlBool } from "kysely";
import type { USER_PROFILE_AVATAR_MIME_TYPES } from "../shared/avatar-limits.js";

export const MAX_USER_PROFILE_DISPLAY_NAME_LENGTH = 256;

export type UserProfileAvatarMime = (typeof USER_PROFILE_AVATAR_MIME_TYPES)[number];

export type UserProfileOwnerErrorCode = "merge" | "role" | "repair-required";

export type UserProfileDisplay = {
  id: string;
  displayName: string | null;
  avatarRevision: string;
  hasAvatar: boolean;
};

export type CachedGitHubIdentity = { profileId: string; updatedAt: number };

export type StoredGitHubIdentity = { accountId: number; login: string };

export type UserProfileGitHubAttribution = Map<string, StoredGitHubIdentity | null>;

export type UserProfileGitHubAttributionRead = {
  identities: UserProfileGitHubAttribution;
  canonicalProfileIds: string[];
};

export type UserChannelIdentity = { channelId: string; accountId: string; senderId: string };
export type UserChannelIdentityLink = { profileId: string; identity: UserChannelIdentity };
export type UserChannelIdentityAuthorityFacts = {
  profileId: string;
  role: string | null;
  emails: string[];
  loginIdentities: string[];
};

export type UserChannelIdentityResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "conflict" | "not-found" }
  | { ok: false; kind: "owner"; code: UserProfileOwnerErrorCode };

export type UserChannelIdentityWorkerOperations = {
  "userProfiles.channelIdentity.change": {
    input: { action: "link" | "unlink"; profileId: string; identity: UserChannelIdentity };
    output: UserChannelIdentityResult<
      { kind: "linked"; link: UserChannelIdentityLink } | { kind: "unlinked"; removed: boolean }
    >;
  };
};

export type UserProfileEmailBinding = {
  email: string;
  profileId: string;
  bindingId: string | null;
};

export type UserProfileAccessFacts = Readonly<{
  profileId: string;
  emails: readonly string[];
  assignedRole: string | null;
}>;

export type PreparedUserProfileIdentity = {
  readCurrentProfile(this: void): Pick<UserProfileAccessFacts, "profileId" | "assignedRole">;
  readonly emailBindingIds: readonly string[];
  readCurrentFacts(
    this: void,
    requiredEmailBindingIds?: readonly string[],
  ): { profile: UserProfileAccessFacts; aliases: ReadonlySet<string> };
  release(this: void): void;
};

export type UserProfileEmailBindingIndex = {
  byEmail: Map<string, UserProfileEmailBinding>;
  byId: Map<string, string>;
  emailsByProfile: Map<string, Set<string>>;
};

export type UserProfilesDatabase = {
  user_profiles: {
    id: string;
    display_name: string | null;
    primary_github_account_id?: number | null;
    avatar: Uint8Array | null;
    avatar_mime: string | null;
    avatar_sha256: string | null;
    merged_into: string | null;
    role?: string | null;
    created_at: number;
    updated_at: number;
  };
  user_profile_emails: {
    email: string;
    profile_id: string;
    binding_id: string | null;
    created_at: number;
  };
  user_profile_identities: {
    provider: string;
    subject: string;
    profile_id: string;
    canonical_login: string | null;
    created_at: number;
  };
};

export type ProfileDisplayRow = Pick<
  UserProfilesDatabase["user_profiles"],
  "id" | "display_name" | "avatar_mime" | "avatar_sha256" | "merged_into" | "updated_at" | "role"
> & { has_avatar: SqlBool };
