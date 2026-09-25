import type { SqlBool } from "kysely";
import type { GatewayConfig } from "../config/types.gateway.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import type { USER_PROFILE_AVATAR_MIME_TYPES } from "../shared/avatar-limits.js";
import type { DB } from "./openclaw-state-db.generated.js";

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

export type UserChannelAuthorizationReference = Readonly<{ version: 1; id: string }>;
export type UserChannelAuthorization = {
  reference: UserChannelAuthorizationReference;
  subject: string;
  grant: GatewayAccessGrantRef | null;
};
export type UserChannelAuthorizationPolicy = {
  roles: NonNullable<GatewayConfig["roles"]> | null;
  identityScopes: NonNullable<NonNullable<GatewayConfig["auth"]>["identityScopes"]> | null;
};

export type UserChannelIdentity = { channelId: string; accountId: string; senderId: string };
export type UserChannelIdentitySelector =
  | UserChannelIdentity
  | { authorizationId: string; policy: UserChannelAuthorizationPolicy };
export type UserChannelIdentityLink = { profileId: string; identity: UserChannelIdentity };
export type UserChannelIdentityAuthorityFacts = {
  authorization?: UserChannelAuthorization;
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
    input:
      | { action: "link" | "unlink"; profileId: string; identity: UserChannelIdentity }
      | { action: "policy"; policy: UserChannelAuthorizationPolicy; configuredOwnersHash?: string }
      | {
          action: "authorize";
          profileId: string;
          identity: UserChannelIdentity;
          policy: UserChannelAuthorizationPolicy;
          grant: GatewayAccessGrantRef | null;
        };
    output: UserChannelIdentityResult<
      | { kind: "linked"; link: UserChannelIdentityLink }
      | { kind: "unlinked"; removed: boolean }
      | { kind: "policy" }
      | { kind: "authorized"; reference: UserChannelAuthorizationReference | undefined }
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
  user_profile_identities: DB["user_profile_identities"];
};

export type ProfileDisplayRow = Pick<
  UserProfilesDatabase["user_profiles"],
  "id" | "display_name" | "avatar_mime" | "avatar_sha256" | "merged_into" | "updated_at" | "role"
> & { has_avatar: SqlBool };
