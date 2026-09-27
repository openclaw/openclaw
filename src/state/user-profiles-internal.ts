import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { expressionBuilder, type SelectQueryBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { USER_PROFILE_AVATAR_MIME_TYPES } from "../shared/avatar-limits.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { stageUserProfileEmailBindingChange } from "./user-profile-events.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import type {
  UserProfileAvatar,
  UserProfileAvatarInspection,
  UserProfileAvatarReadCommand,
  UserProfileAvatarRepresentation,
} from "./user-profiles-avatar.types.js";
import {
  hasEnsuredUserProfileRoleSchema,
  UserProfileNotFoundError,
} from "./user-profiles-schema.js";
import type {
  PreparedUserProfileIdentity,
  ProfileDisplayRow,
  UserProfile,
  UserProfileDisplay,
  UserProfileAvatarMime,
  UserProfileEmailBinding,
  UserProfileEmailBindingIndex,
  UserProfilesDatabase,
} from "./user-profiles.types.js";

export type UserProfileRow = UserProfilesDatabase["user_profiles"];
export type UserProfileMetadataRow = Omit<UserProfileRow, "avatar">;

const metadataReaders = new WeakMap<
  DatabaseSync,
  (profileId: string) => UserProfileMetadataRow | undefined
>();

export function insertUserProfile(
  db: DatabaseSync,
  displayName: string | null,
  now: number,
  mutation?: UserProfileMutationContext,
): UserProfileRow {
  const row: UserProfileRow = {
    id: generateSecureUuid(),
    display_name: displayName,
    avatar: null,
    avatar_mime: null,
    avatar_sha256: null,
    merged_into: null,
    created_at: now,
    updated_at: now,
  };
  mutation?.before(db, row.id);
  executeSqliteQuerySync(db, userProfilesDb(db).insertInto("user_profiles").values(row));
  return row;
}

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

export function userProfilesDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserProfilesDatabase>(db);
}

export function selectUserProfileEmailAlias(db: DatabaseSync, email: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", email),
  );
}

/** Keep each exact binding and its profile's email projection in the same committed update. */
export function applyUserProfileEmailBinding(
  bindings: UserProfileEmailBindingIndex,
  email: string,
  binding: UserProfileEmailBinding | null,
): string | undefined {
  const previous = bindings.byEmail.get(email);
  if (previous) {
    if (previous.bindingId) {
      bindings.byId.delete(previous.bindingId);
    }
    const emails = bindings.emailsByProfile.get(previous.profileId);
    emails?.delete(email);
    if (emails?.size === 0) {
      bindings.emailsByProfile.delete(previous.profileId);
    }
  }
  if (binding) {
    bindings.byEmail.set(email, binding);
    if (binding.bindingId) {
      bindings.byId.set(binding.bindingId, binding.profileId);
    }
    const emails = bindings.emailsByProfile.get(binding.profileId) ?? new Set<string>();
    emails.add(email);
    bindings.emailsByProfile.set(binding.profileId, emails);
  } else {
    bindings.byEmail.delete(email);
  }
  return previous?.profileId;
}

/** A binding survives same-owner refreshes; an actual transfer starts a new lifetime. */
export function setUserProfileEmailBinding(
  db: DatabaseSync,
  email: string,
  profileId: string,
  now: number,
): void {
  const bindingId = generateSecureUuid();
  const result = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .insertInto("user_profile_emails")
      .values({ email, profile_id: profileId, binding_id: bindingId, created_at: now })
      .onConflict((conflict) =>
        conflict
          .column("email")
          .doUpdateSet({ profile_id: profileId, binding_id: bindingId })
          .where("user_profile_emails.profile_id", "!=", profileId),
      ),
  );
  if (result.numAffectedRows === 1n) {
    stageUserProfileEmailBindingChange(db, email, { email, profileId, bindingId });
  }
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

function normalizeUserProfileAvatarMime(value: string | null): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.find((candidate) => candidate === value) ?? null;
}

export function selectResolvedUserProfile<T extends Pick<UserProfileRow, "merged_into">>(
  db: DatabaseSync,
  profileId: string,
  query: SelectQueryBuilder<UserProfilesDatabase, "user_profiles", T>,
): T | undefined {
  return readResolvedUserProfile(profileId, (id) =>
    executeSqliteQueryTakeFirstSync(db, query.where("id", "=", id)),
  );
}

function readResolvedUserProfile<T extends Pick<UserProfileRow, "merged_into">>(
  profileId: string,
  read: (profileId: string) => T | undefined,
): T | undefined {
  const profile = read(profileId);
  if (!profile?.merged_into) {
    return profile;
  }
  // Merge writers repoint aliases and existing tombstones, so durable profile
  // references need exactly one hop to reach the canonical row.
  return read(profile.merged_into) ?? profile;
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
  let read = metadataReaders.get(db);
  if (!read) {
    // Reuse compilation only; every authority check binds and reads current rows.
    read = prepareSqliteQueryTakeFirstSync<string, UserProfileMetadataRow>(db, (parameter) =>
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
        ])
        .where(
          "id",
          "=",
          parameter((id) => id),
        ),
    );
    metadataReaders.set(db, read);
  }
  return readResolvedUserProfile(profileId, read);
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

const avatarRoleColumns = new WeakMap<SqliteSchemaFacts, boolean>();

function selectProfileAvatarMetadata(db: DatabaseSync, profileId: string) {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Profile avatar reads require admitted schema facts");
  }
  const sql = schema.tableSql.get("user_profiles");
  if (!sql) {
    return undefined;
  }
  let hasRole = avatarRoleColumns.get(schema);
  if (hasRole === undefined) {
    hasRole = parseSqliteTableDefinition(sql, "user_profiles").columns.has("role");
    avatarRoleColumns.set(schema, hasRole);
  }
  return selectResolvedUserProfile(
    db,
    profileId,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select([...userProfileDisplaySelection, "created_at"])
      .select((eb) => [
        hasRole ? "role" : eb.val<string | null>(null).as("role"),
        eb.fn<number | null>("length", ["avatar"]).as("avatar_byte_length"),
      ]),
  );
}

export function inspectProfileAvatarInDatabase(
  db: DatabaseSync,
  profileId: string,
): UserProfileAvatarInspection {
  return runSqliteDeferredTransactionSync(db, () => {
    const profile = selectProfileAvatarMetadata(db, profileId);
    const mime = normalizeUserProfileAvatarMime(profile?.avatar_mime ?? null);
    const avatar =
      profile?.has_avatar && mime && profile.avatar_sha256
        ? {
            mime,
            sha256: profile.avatar_sha256,
            updatedAt: profile.updated_at,
            byteLength: profile.avatar_byte_length ?? 0,
          }
        : undefined;
    return {
      profile: profile && toUserProfile(profile),
      hasAvatar: profile?.has_avatar === 1,
      avatar,
      emails:
        profile && !avatar
          ? executeSqliteQuerySync(
              db,
              userProfilesDb(db)
                .selectFrom("user_profile_emails")
                .select("email")
                .where("profile_id", "=", profile.id)
                .orderBy("email", "asc"),
            ).rows.map(({ email }) => email)
          : [],
    };
  });
}

function readProfileAvatarInDatabase(
  db: DatabaseSync,
  profileId: string,
  expected: UserProfileAvatarRepresentation,
): UserProfileAvatar | undefined {
  return runSqliteDeferredTransactionSync(db, () => {
    const profile = selectProfileAvatarMetadata(db, profileId);
    const mime = normalizeUserProfileAvatarMime(profile?.avatar_mime ?? null);
    if (
      !profile?.has_avatar ||
      !mime ||
      !profile.avatar_sha256 ||
      profile.id !== expected.canonicalProfileId ||
      profile.avatar_sha256 !== expected.sha256 ||
      mime !== expected.mime
    ) {
      return undefined;
    }
    const bytes = executeSqliteQueryTakeFirstSync(
      db,
      userProfilesDb(db).selectFrom("user_profiles").select("avatar").where("id", "=", profile.id),
    )?.avatar;
    return bytes
      ? { bytes, mime, sha256: profile.avatar_sha256, updatedAt: profile.updated_at }
      : undefined;
  });
}

export function readUserProfileAvatarCommand(
  db: DatabaseSync,
  command: UserProfileAvatarReadCommand,
) {
  return command.type === "userProfiles.avatar.inspect"
    ? { type: command.type, inspection: inspectProfileAvatarInDatabase(db, command.profileId) }
    : {
        type: command.type,
        avatar: readProfileAvatarInDatabase(db, command.profileId, command.expected),
      };
}

export function projectUserProfileDisplay(
  profile: Omit<ProfileDisplayRow, "role">,
): UserProfileDisplay {
  const avatarMime = normalizeUserProfileAvatarMime(profile.avatar_mime);
  return {
    id: profile.id,
    displayName: profile.display_name,
    avatarRevision:
      profile.avatar_sha256 && avatarMime
        ? `${profile.avatar_sha256}-${avatarMime.slice("image/".length)}`
        : String(profile.updated_at),
    hasAvatar: profile.has_avatar === 1,
  };
}

/** Prefix references navigate display rows; they never select an authentication identity. */
export function matchUserProfileReference(
  reference: string,
  exact: string | undefined,
  readMatches: (prefix: string) => string[],
): Result<string | undefined, "ambiguous"> {
  if (exact !== undefined || !/^[0-9a-f]{8,32}$/.test(reference)) {
    return ok<string | undefined, "ambiguous">(exact);
  }
  const prefix = [0, 8, 12, 16, 20]
    .map((start, index, offsets) => reference.slice(start, offsets[index + 1]))
    .filter(Boolean)
    .join("-");
  const matches = new Set(readMatches(prefix));
  return matches.size > 1
    ? err<string | undefined, "ambiguous">("ambiguous")
    : ok<string | undefined, "ambiguous">(matches.values().next().value);
}

export function resolveCatalogProfile(rows: Map<string, ProfileDisplayRow>, id: string) {
  const raw = rows.get(id);
  return rows.get(raw?.merged_into ?? id) ?? raw;
}

/** Project exact identity facts from the catalogue owner's current rows. */
export function projectCatalogUserProfileIdentity(
  resident: Map<string, ProfileDisplayRow>,
  profileId: string,
) {
  const profile = resolveCatalogProfile(resident, profileId);
  return (
    profile && {
      profileId: profile.id,
      role: profile.role ?? null,
      aliases: new Set(
        [...resident.values()]
          .filter((row) => row.id === profile.id || row.merged_into === profile.id)
          .map((row) => row.id),
      ),
    }
  );
}

/** Bind a canonical account and its original email lifetimes to the retained catalog owner. */
export function bindPreparedUserProfileIdentity(
  profileId: string,
  catalog: {
    rows: Map<string, ProfileDisplayRow>;
    bindings: UserProfileEmailBindingIndex;
    assertCurrent: (profileId: string) => void;
    release: () => void;
  },
): PreparedUserProfileIdentity {
  const { rows, bindings } = catalog;
  const initial = [...bindings.byEmail.values()].filter(
    (binding) => binding.profileId === profileId,
  );
  const ids = Object.freeze(
    initial.flatMap((binding) => (binding.bindingId ? [binding.bindingId] : [])).toSorted(),
  );
  const assertCurrent = (requiredEmailBindingIds: readonly string[] = []) => {
    catalog.assertCurrent(profileId);
    if (
      resolveCatalogProfile(rows, profileId)?.id !== profileId ||
      requiredEmailBindingIds.some((id) => bindings.byId.get(id) !== profileId)
    ) {
      throw new UserProfileNotFoundError(profileId);
    }
  };
  function readCurrentProfile(this: void, requiredEmailBindingIds?: readonly string[]) {
    assertCurrent(requiredEmailBindingIds);
    return { profileId, assignedRole: rows.get(profileId)?.role || null };
  }
  return {
    readCurrentProfile,
    get emailBindingIds() {
      assertCurrent();
      if (initial.some((binding) => binding.bindingId === null)) {
        throw new UserProfileNotFoundError(profileId);
      }
      return ids;
    },
    readCurrentFacts(this: void, requiredEmailBindingIds) {
      const profile = readCurrentProfile(requiredEmailBindingIds);
      const aliases = new Set([profileId]);
      for (const row of rows.values()) {
        if (row.merged_into === profileId) {
          aliases.add(row.id);
        }
      }
      return {
        profile: {
          profileId: profile.profileId,
          emails: [...(bindings.emailsByProfile.get(profileId) ?? [])].toSorted(),
          assignedRole: profile.assignedRole,
        },
        aliases,
      };
    },
    release: catalog.release,
  };
}
