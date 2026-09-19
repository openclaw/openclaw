import type { DatabaseSync } from "node:sqlite";
import { expressionBuilder, type SelectQueryBuilder } from "kysely";
import type { UserProfile as UserProfileListItem } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  ensureUserProfilesSchema,
  hasEnsuredUserProfileRoleSchema,
  UserProfileNotFoundError,
} from "./user-profiles-schema.js";
import {
  USER_PROFILE_AVATAR_MIME_TYPES,
  type UserProfileAvatarMime,
  type UserProfilesDatabase,
} from "./user-profiles.types.js";

export type UserProfileRow = UserProfilesDatabase["user_profiles"];
export type UserProfileMetadataRow = Omit<UserProfileRow, "avatar">;
export type UserProfile = Omit<UserProfileListItem, "emails" | "githubIdentity" | "hasAvatar">;

export function toUserProfile(row: Omit<UserProfileMetadataRow, "avatar_sha256">): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMime: normalizeUserProfileAvatarMime(row.avatar_mime),
    mergedInto: row.merged_into,
    ...(row.role ? { role: row.role } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Selection metadata is immutable and carries no database handle or profile state.
export const userProfileAvatarPresence = expressionBuilder<UserProfilesDatabase, "user_profiles">()(
  "avatar",
  "is not",
  null,
).as("has_avatar");
type UserProfileAvatar = {
  bytes: Uint8Array;
  mime: UserProfileAvatarMime;
  sha256: string;
  updatedAt: number;
};

export function userProfilesDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserProfilesDatabase>(db);
}

export const userProfileDisplaySelection = [
  "id",
  "display_name",
  "avatar_mime",
  "avatar_sha256",
  "merged_into",
  "updated_at",
  userProfileAvatarPresence,
] as const;

export function selectProfileDisplayEntries(db: DatabaseSync, ids?: string[]) {
  const query = userProfilesDb(db)
    .selectFrom("user_profiles")
    .select([
      ...userProfileDisplaySelection,
      ...(hasEnsuredUserProfileRoleSchema(db) || tableHasColumn(db, "user_profiles", "role")
        ? (["role"] as const)
        : []),
    ]);
  const rows = executeSqliteQuerySync(db, ids ? query.where("id", "in", ids) : query).rows;
  // Worker transfer removes SQLite rows' null prototype; compare plain descriptors on both sides.
  return rows.map((row): [string, typeof row] => [row.id, { ...row }]);
}

export function normalizeUserProfileAvatarMime(value: string | null): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.find((candidate) => candidate === value) ?? null;
}

export function selectResolvedUserProfile<T extends Pick<UserProfileRow, "merged_into">>(
  db: DatabaseSync,
  profileId: string,
  query: SelectQueryBuilder<UserProfilesDatabase, "user_profiles", T>,
): T | undefined {
  const profile = executeSqliteQueryTakeFirstSync(db, query.where("id", "=", profileId));
  if (!profile?.merged_into) {
    return profile;
  }
  // Merge writers repoint aliases and existing tombstones, so durable profile
  // references need exactly one hop to reach the canonical row.
  return (
    executeSqliteQueryTakeFirstSync(db, query.where("id", "=", profile.merged_into)) ?? profile
  );
}

export function selectResolvedUserProfileById(
  db: DatabaseSync,
  profileId: string,
): UserProfileRow | undefined {
  return selectResolvedUserProfile(
    db,
    profileId,
    userProfilesDb(db).selectFrom("user_profiles").selectAll(),
  );
}

/** Keep native row validation while omitting avatar payloads from metadata reads. */
export function selectResolvedUserProfileMetadataById(
  db: DatabaseSync,
  profileId: string,
): UserProfileMetadataRow | undefined {
  if (!hasEnsuredUserProfileRoleSchema(db)) {
    return selectResolvedUserProfileById(db, profileId);
  }
  return selectResolvedUserProfile(
    db,
    profileId,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select((eb) => [
        "id",
        "display_name",
        // Preserve native conversion errors for non-BLOB values in damaged profile rows.
        eb
          .case()
          .when(eb.fn<string>("typeof", ["avatar"]), "=", "blob")
          .then(null)
          .else(eb.ref("avatar"))
          .end()
          .as("avatar"),
        "avatar_mime",
        "avatar_sha256",
        "merged_into",
        "role",
        "created_at",
        "updated_at",
      ]),
  );
}

export function requireResolvedUserProfileMetadataById(
  db: DatabaseSync,
  profileId: string,
): UserProfileMetadataRow {
  const profile = selectResolvedUserProfileMetadataById(db, profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profile;
}

export function requireResolvedUserProfileById(
  db: DatabaseSync,
  profileId: string,
): UserProfileRow {
  const profile = selectResolvedUserProfileById(db, profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profile;
}

export function formatUserProfileAvatarEtag(sha256: string, mime: UserProfileAvatarMime): string {
  return `"${sha256}-${mime.slice("image/".length)}"`;
}

export function getProfileAvatar(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAvatar | undefined {
  ensureUserProfilesSchema(options);
  const profile = selectResolvedUserProfileById(openOpenClawStateDatabase(options).db, profileId);
  const mime = normalizeUserProfileAvatarMime(profile?.avatar_mime ?? null);
  return profile?.avatar && mime && profile.avatar_sha256
    ? { bytes: profile.avatar, mime, sha256: profile.avatar_sha256, updatedAt: profile.updated_at }
    : undefined;
}
