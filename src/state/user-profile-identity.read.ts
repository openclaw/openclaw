import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import {
  matchUserProfileReference,
  selectResolvedUserProfile,
  selectUserProfileEmailAlias,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
  userProfileDisplaySelection,
  toUserProfile,
} from "./user-profiles-internal.js";
import {
  ensureUserProfilesSchema,
  hasEnsuredUserProfileRoleSchema,
} from "./user-profiles-schema.js";
import type { ProfileDisplayRow, UserProfileEmailBinding } from "./user-profiles.types.js";

export const profileCatalogPath = (options: OpenClawStateDatabaseOptions) =>
  path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));

/** Worker hydration retains unknown legacy bindings without inventing their lifetime. */
export function readUserProfileEmailBindings(
  db: DatabaseSync,
  profileIds?: string | readonly string[],
): UserProfileEmailBinding[] {
  if (
    (Array.isArray(profileIds) && profileIds.length === 0) ||
    !tableExists(db, "user_profile_emails")
  ) {
    return [];
  }
  const query = userProfilesDb(db)
    .selectFrom("user_profile_emails")
    .select(["email", "profile_id"])
    .select((eb) => [
      tableHasColumn(db, "user_profile_emails", "binding_id")
        ? "binding_id"
        : eb.val<string | null>(null).as("binding_id"),
    ])
    .orderBy("email", "asc");
  return executeSqliteQuerySync(
    db,
    profileIds === undefined
      ? query
      : typeof profileIds === "string"
        ? query.where("profile_id", "=", profileIds)
        : query.where("profile_id", "in", [...profileIds]),
  ).rows.map(({ email, profile_id, binding_id }) => ({
    email,
    profileId: profile_id,
    bindingId: binding_id,
  }));
}

/** Alias lookup is observational and never initializes profile storage. */
export function readUserProfileIdForEmail(db: DatabaseSync, email: string): string | undefined {
  if (!tableExists(db, "user_profile_emails") || !tableExists(db, "user_profiles")) {
    return undefined;
  }
  const alias = selectUserProfileEmailAlias(db, email);
  return alias ? selectResolvedUserProfileMetadataById(db, alias.profile_id)?.id : undefined;
}

export function listUserProfilesSync(options: OpenClawStateDatabaseOptions = {}) {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const kysely = userProfilesDb(database.db);
      const profiles = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profiles")
          .select([
            ...userProfileDisplaySelection,
            "created_at",
            // The native role writer can add this column after a worker has opened.
            ...(hasEnsuredUserProfileRoleSchema(database.db) ||
            tableHasColumn(database.db, "user_profiles", "role")
              ? (["role"] as const)
              : []),
          ])
          .orderBy("created_at", "asc")
          .orderBy("id", "asc"),
      ).rows;
      const emails = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profile_emails")
          .select(["profile_id", "email"])
          .orderBy("email", "asc"),
      ).rows;
      const githubIdentities = selectUserProfileGitHubIdentities(database.db);
      const emailsByProfile = new Map<string, string[]>(profiles.map(({ id }) => [id, []]));
      for (const { profile_id, email } of emails) {
        emailsByProfile.get(profile_id)?.push(email);
      }
      return profiles.map((profile) =>
        Object.assign(toUserProfile(profile), {
          emails: emailsByProfile.get(profile.id) ?? [],
          githubIdentity: githubIdentities.get(profile.id) ?? null,
          hasAvatar: profile.has_avatar === 1,
        }),
      );
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.list" },
  );
}

/** Disclosure scopes need current aliases, never the resident display catalog. */
export function readCurrentUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(database.db, () => {
    const canonicalId =
      selectResolvedUserProfileMetadataById(database.db, profileId)?.id ?? profileId;
    const aliases = executeSqliteQuerySync(
      database.db,
      userProfilesDb(database.db)
        .selectFrom("user_profiles")
        .select("id")
        .where("merged_into", "=", canonicalId),
    ).rows;
    return new Set([canonicalId, ...aliases.map((row) => row.id)]);
  });
}

/** In-memory counterpart of the bounded SQL selector for the Gateway catalog. */
export function projectHasMultipleSessionSharingIdentities(
  rows: ReadonlyMap<string, ProfileDisplayRow>,
): boolean {
  let people = 0;
  for (const row of rows.values()) {
    if (!row.merged_into && row.id !== GATEWAY_OWNER_PROFILE_ID && ++people === 2) {
      return true;
    }
  }
  return false;
}

/** True when session-sharing policy can distinguish at least two durable people. */
export function selectHasMultipleSessionSharingIdentities(db: DatabaseSync): boolean {
  const profiles = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select("id")
      .where("merged_into", "is", null)
      .where("id", "!=", GATEWAY_OWNER_PROFILE_ID)
      .limit(2),
  ).rows;
  return profiles.length >= 2;
}

/** Exact canonical identity and aliases selected on the caller's admitted connection. */
export function selectUserProfileIdentityInDatabase(db: DatabaseSync, profileId: string) {
  const profile = selectResolvedUserProfileMetadataById(db, profileId);
  return (
    profile && {
      profileId: profile.id,
      role: profile.role ?? null,
      aliases: new Set(
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .selectFrom("user_profiles")
            .select("id")
            .where((eb) => eb.or([eb("id", "=", profile.id), eb("merged_into", "=", profile.id)])),
        ).rows.map((row) => row.id),
      ),
    }
  );
}

/** Read display rows and their one-hop aliases without creating profile storage. */
export function selectUserProfileDisplaysInDatabase(
  db: DatabaseSync,
  ids: readonly string[],
): Map<string, Omit<ProfileDisplayRow, "role"> | undefined> {
  const profiles = userProfilesDb(db).selectFrom("user_profiles");
  const rows = executeSqliteQuerySync(
    db,
    profiles.select(userProfileDisplaySelection).where((eb) =>
      eb.or([
        eb("id", "in", [...ids]),
        eb(
          "id",
          "in",
          profiles
            .select("merged_into")
            .where("id", "in", [...ids])
            .where("merged_into", "!=", ""),
        ),
      ]),
    ),
  ).rows;
  if (
    rows.some(
      (row) =>
        typeof row.id !== "string" ||
        (row.merged_into !== null && typeof row.merged_into !== "string"),
    )
  ) {
    // Native BLOB keys compare by value in SQLite, not by Map object identity.
    return new Map(
      ids.map((id) => [
        id,
        selectResolvedUserProfile(db, id, profiles.select(userProfileDisplaySelection)),
      ]),
    );
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(
    ids.map((id) => {
      // Match native text binding before indexing the returned SQLite rows.
      const raw = byId.get(toUSVString(id));
      return [id, raw?.merged_into ? (byId.get(raw.merged_into) ?? raw) : raw];
    }),
  );
}

/** Resolve display navigation against the caller's admitted database and visible profile IDs. */
export function selectUserProfileReferenceInDatabase(
  db: DatabaseSync,
  reference: string,
  allowedProfileIds?: ReadonlySet<string>,
) {
  let profiles = userProfilesDb(db).selectFrom("user_profiles");
  if (allowedProfileIds) {
    profiles = profiles.where((eb) =>
      eb(eb.fn.coalesce("merged_into", "id"), "in", [...allowedProfileIds]),
    );
  }
  return matchUserProfileReference(
    reference,
    selectResolvedUserProfile(db, reference, profiles.select(["id", "merged_into"]))?.id,
    (prefix) =>
      executeSqliteQuerySync(
        db,
        profiles
          .select((eb) => eb.fn.coalesce("merged_into", "id").as("id"))
          .where("id", "like", `${prefix}%`)
          .distinct()
          .limit(2),
      ).rows.map((row) => row.id),
  );
}
