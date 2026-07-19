// Durable user profiles and mutable login-email aliases in the shared state DB.
import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { USER_PROFILES_SCHEMA_SQL } from "./user-profiles-schema.js";

export const MAX_USER_PROFILE_AVATAR_BYTES = 512 * 1024;
export const USER_PROFILE_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type UserProfileAvatarMime = (typeof USER_PROFILE_AVATAR_MIME_TYPES)[number];

export type UserProfile = {
  id: string;
  displayName: string | null;
  avatarMime: UserProfileAvatarMime | null;
  mergedInto: string | null;
  createdAt: number;
  updatedAt: number;
};

export type UserProfileListItem = UserProfile & {
  emails: string[];
  hasAvatar: boolean;
};

export type UserProfileAvatar = {
  bytes: Uint8Array;
  mime: UserProfileAvatarMime;
  updatedAt: number;
};

export type UserProfileAvatarError =
  | { code: "avatar_too_large"; maxBytes: number }
  | { code: "unsupported_avatar_mime"; mime: string };

export class UserProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`user profile not found: ${profileId}`);
    this.name = "UserProfileNotFoundError";
  }
}

type UserProfilesDatabase = {
  user_profiles: {
    id: string;
    display_name: string | null;
    avatar: Uint8Array | null;
    avatar_mime: string | null;
    merged_into: string | null;
    created_at: number;
    updated_at: number;
  };
  user_profile_emails: {
    email: string;
    profile_id: string;
    created_at: number;
  };
};

type UserProfileRow = UserProfilesDatabase["user_profiles"];

const ensuredDatabases = new WeakSet<DatabaseSync>();

function profileDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserProfilesDatabase>(db);
}

function ensureUserProfilesSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (ensuredDatabases.has(db)) {
        return;
      }
      db.exec(USER_PROFILES_SCHEMA_SQL);
      ensuredDatabases.add(db);
    },
    options,
    { operationLabel: "user-profiles.schema.ensure" },
  );
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("email must not be empty");
  }
  return normalized;
}

function toAvatarMime(value: string | null): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.includes(value as UserProfileAvatarMime)
    ? (value as UserProfileAvatarMime)
    : null;
}

function toUserProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMime: toAvatarMime(row.avatar_mime),
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectProfileById(db: DatabaseSync, profileId: string): UserProfileRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    profileDb(db).selectFrom("user_profiles").selectAll().where("id", "=", profileId),
  );
}

function selectResolvedProfileById(
  db: DatabaseSync,
  profileId: string,
): UserProfileRow | undefined {
  const profile = selectProfileById(db, profileId);
  if (!profile?.merged_into) {
    return profile;
  }
  // Aliases are re-pointed on merge. This one hop only preserves references
  // written before that merge without turning tombstones into an unbounded chain.
  return selectProfileById(db, profile.merged_into) ?? profile;
}

function requireResolvedProfileById(db: DatabaseSync, profileId: string): UserProfileRow {
  const profile = selectResolvedProfileById(db, profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profile;
}

/** Resolves a profile from a normalized email alias, following one merge tombstone at most. */
export function resolveProfileByEmail(
  email: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile | undefined {
  const normalizedEmail = normalizeEmail(email);
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const alias = executeSqliteQueryTakeFirstSync(
    db,
    profileDb(db)
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", normalizedEmail),
  );
  if (!alias) {
    return undefined;
  }
  const profile = selectResolvedProfileById(db, alias.profile_id);
  return profile ? toUserProfile(profile) : undefined;
}

/** Resolves an email alias or atomically creates its first durable profile. */
export function ensureProfileForEmail(
  email: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  const normalizedEmail = normalizeEmail(email);
  const profileId = generateSecureUuid();
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = profileDb(db);
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (existingAlias) {
        return toUserProfile(requireResolvedProfileById(db, existingAlias.profile_id));
      }
      const row: UserProfileRow = {
        id: profileId,
        display_name: normalizedEmail.split("@", 1)[0] || normalizedEmail,
        avatar: null,
        avatar_mime: null,
        merged_into: null,
        created_at: now,
        updated_at: now,
      };
      executeSqliteQuerySync(db, kysely.insertInto("user_profiles").values(row));
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_emails").values({
          email: normalizedEmail,
          profile_id: profileId,
          created_at: now,
        }),
      );
      return toUserProfile(row);
    },
    options,
    { operationLabel: "user-profiles.ensure" },
  );
}

/** Links an email to a profile and retains an aliasless prior profile as a merge tombstone. */
export function linkEmail(
  email: string,
  targetProfileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = profileDb(db);
      const target = requireResolvedProfileById(db, targetProfileId);
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (!existingAlias) {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("user_profile_emails").values({
            email: normalizedEmail,
            profile_id: target.id,
            created_at: now,
          }),
        );
        return toUserProfile(target);
      }
      if (existingAlias.profile_id === target.id) {
        return toUserProfile(target);
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("user_profile_emails")
          .set({ profile_id: target.id })
          .where("email", "=", normalizedEmail),
      );
      const remainingAliases = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("email")
          .where("profile_id", "=", existingAlias.profile_id),
      ).rows;
      if (remainingAliases.length === 0) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ merged_into: target.id, updated_at: now })
            .where("id", "=", existingAlias.profile_id),
        );
      }
      return toUserProfile(target);
    },
    options,
    { operationLabel: "user-profiles.link-email" },
  );
}

export function setDisplayName(
  profileId: string,
  name: string | null,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedProfileById(db, profileId);
      executeSqliteQuerySync(
        db,
        profileDb(db)
          .updateTable("user_profiles")
          .set({ display_name: name, updated_at: now })
          .where("id", "=", profile.id),
      );
      return { ...toUserProfile(profile), displayName: name, updatedAt: now };
    },
    options,
    { operationLabel: "user-profiles.set-display-name" },
  );
}

/** Stores a bounded, allowlisted avatar without ever leaving the write transaction async. */
export function setAvatar(
  profileId: string,
  bytes: Uint8Array,
  mime: string,
  options: OpenClawStateDatabaseOptions = {},
): Result<UserProfile, UserProfileAvatarError> {
  if (bytes.byteLength > MAX_USER_PROFILE_AVATAR_BYTES) {
    return err({ code: "avatar_too_large", maxBytes: MAX_USER_PROFILE_AVATAR_BYTES });
  }
  if (!USER_PROFILE_AVATAR_MIME_TYPES.includes(mime as UserProfileAvatarMime)) {
    return err({ code: "unsupported_avatar_mime", mime });
  }
  const now = Date.now();
  ensureUserProfilesSchema(options);
  const value = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedProfileById(db, profileId);
      executeSqliteQuerySync(
        db,
        profileDb(db)
          .updateTable("user_profiles")
          .set({ avatar: bytes, avatar_mime: mime, updated_at: now })
          .where("id", "=", profile.id),
      );
      return {
        ...toUserProfile(profile),
        avatarMime: mime as UserProfileAvatarMime,
        updatedAt: now,
      };
    },
    options,
    { operationLabel: "user-profiles.set-avatar" },
  );
  return ok(value);
}

export function getProfileAvatar(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAvatar | undefined {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profile = selectResolvedProfileById(db, profileId);
  if (!profile?.avatar || !profile.avatar_mime) {
    return undefined;
  }
  const mime = toAvatarMime(profile.avatar_mime);
  return mime ? { bytes: profile.avatar, mime, updatedAt: profile.updated_at } : undefined;
}

export function listProfiles(options: OpenClawStateDatabaseOptions = {}): UserProfileListItem[] {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const kysely = profileDb(db);
  const profiles = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profiles")
      .selectAll()
      .orderBy("created_at", "asc")
      .orderBy("id", "asc"),
  ).rows;
  const emails = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_emails")
      .select(["profile_id", "email"])
      .orderBy("email", "asc"),
  ).rows;
  const emailsByProfile = new Map<string, string[]>();
  for (const email of emails) {
    const list = emailsByProfile.get(email.profile_id) ?? [];
    list.push(email.email);
    emailsByProfile.set(email.profile_id, list);
  }
  return profiles.map((profile) => ({
    ...toUserProfile(profile),
    emails: emailsByProfile.get(profile.id) ?? [],
    hasAvatar: profile.avatar !== null,
  }));
}
