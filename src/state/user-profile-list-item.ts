import type { DatabaseSync } from "node:sqlite";
import type { UserProfile as UserProfileListItem } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import {
  toUserProfile,
  userProfileAvatarPresence,
  userProfilesDb,
} from "./user-profiles-internal.js";
import {
  hasEnsuredUserProfileRoleSchema,
  UserProfileNotFoundError,
} from "./user-profiles-schema.js";

export function selectUserProfileListItemById(
  db: DatabaseSync,
  profileId: string,
): UserProfileListItem {
  const kysely = userProfilesDb(db);
  const profile = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profiles")
      .select([
        "id",
        "display_name",
        "avatar_mime",
        "merged_into",
        ...(hasEnsuredUserProfileRoleSchema(db) || tableHasColumn(db, "user_profiles", "role")
          ? (["role"] as const)
          : []),
        "created_at",
        "updated_at",
        userProfileAvatarPresence,
      ])
      .where("id", "=", profileId),
  );
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  const emails = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_emails")
      .select("email")
      .where("profile_id", "=", profileId)
      .orderBy("email", "asc"),
  ).rows;
  return {
    ...toUserProfile(profile),
    emails: emails.map((alias) => alias.email),
    githubIdentity: selectUserProfileGitHubIdentities(db, [profileId]).get(profileId) ?? null,
    hasAvatar: profile.has_avatar === 1,
  };
}
