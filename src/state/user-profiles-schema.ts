import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { stageUserProfileEmailBindingChange } from "./user-profile-events.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import type { UserProfilesDatabase, UserProfileOwnerErrorCode } from "./user-profiles.types.js";

// Canonical additive schema for durable user profiles. Kept feature-local so
// ordinary shared-state opens do not create identity tables until they are used.
const USER_PROFILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT,
  primary_github_account_id INTEGER,
  avatar BLOB,
  avatar_mime TEXT,
  avatar_sha256 TEXT,
  merged_into TEXT,
  role TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS user_profile_emails (
  email TEXT NOT NULL PRIMARY KEY,
  profile_id TEXT NOT NULL,
  binding_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_profile_emails_profile_id
  ON user_profile_emails(profile_id);

${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "user_profile_identities")}
`;

export class UserProfileNotFoundError extends Error {
  constructor(readonly profileId: string) {
    super(`user profile not found: ${profileId}`);
    this.name = "UserProfileNotFoundError";
  }
}

export class UserProfileOwnerError extends Error {
  constructor(readonly code: UserProfileOwnerErrorCode) {
    super(
      code === "repair-required"
        ? "the shared owner profile requires repair; run openclaw doctor --fix and reconnect"
        : code === "merge"
          ? "the shared owner profile cannot be merged; sign in with a personal identity instead"
          : "the shared owner profile is not governed by operator roles",
    );
    this.name = "UserProfileOwnerError";
  }
}

const ensuredDatabases = new WeakSet<DatabaseSync>();
const roleEnsuredDatabases = new WeakSet<DatabaseSync>();

function rememberEnsuredSchema(database: DatabaseSync, cache: WeakSet<DatabaseSync>): void {
  if (cache.has(database)) {
    return;
  }
  const remember = () => {
    cache.add(database);
  };
  // A nested ensure is valid in its transaction but must disappear with its savepoint.
  if (
    !stageSqliteTransactionState(database, {
      stage: remember,
      rollback: () => {
        cache.delete(database);
      },
      commit: remember,
    })
  ) {
    remember();
  }
}

export function ensureUserProfilesSchema(
  options: UserProfileMutationOptions,
  database = openOpenClawStateDatabase(options),
): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  let hasRoleColumn = false;
  runUserProfileWriteTransaction(
    ({ db }) => {
      db.exec(USER_PROFILES_SCHEMA_SQL); // sqlite-allow-raw -- Canonical feature-local additive DDL.
      ensureColumn(db, "user_profile_identities", "canonical_login TEXT");
      ensureColumn(db, "user_profile_identities", "authorization_id TEXT");
      ensureColumn(db, "user_profile_identities", "authorization_basis_json TEXT");
      db.exec(
        extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "user_profile_identities", {
          endMarker: "ON user_profile_identities(authorization_id);",
        }),
      ); // sqlite-allow-raw -- Canonical first-use channel-link indexes after additive columns.
      ensureColumn(db, "user_profiles", "primary_github_account_id INTEGER");
      ensureColumn(db, "user_profile_emails", "binding_id TEXT");
      const kysely = getNodeSqliteKysely<UserProfilesDatabase>(db);
      const unboundEmails = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select(["email", "profile_id"])
          .where("binding_id", "is", null),
      ).rows;
      const profiles = [...new Set(unboundEmails.map((row) => row.profile_id))];
      options.mutation?.before(db, ...profiles);
      for (const { email, profile_id } of unboundEmails) {
        const bindingId = generateSecureUuid();
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profile_emails")
            .set({ binding_id: bindingId })
            .where("email", "=", email)
            .where("binding_id", "is", null),
        );
        stageUserProfileEmailBindingChange(db, email, {
          email,
          profileId: profile_id,
          bindingId,
        });
      }
      options.mutation?.publish(...profiles);
      hasRoleColumn = tableHasColumn(db, "user_profiles", "role");
    },
    options,
    { operationLabel: "user-profiles.schema.ensure" },
  );
  // A rolled-back ensure must retry rather than caching a missing table/column.
  rememberEnsuredSchema(database.db, ensuredDatabases);
  if (hasRoleColumn) {
    rememberEnsuredSchema(database.db, roleEnsuredDatabases);
  }
}

export function ensureUserProfileRoleSchema(
  options: OpenClawStateDatabaseOptions,
  database = openOpenClawStateDatabase(options),
): void {
  if (roleEnsuredDatabases.has(database.db)) {
    return;
  }
  ensureUserProfilesSchema(options, database);
  if (roleEnsuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureColumn(db, "user_profiles", "role TEXT"),
    options,
    { operationLabel: "user-profiles.role.schema.ensure" },
  );
  // Keep the cache aligned with both nested rollback and the outer commit.
  rememberEnsuredSchema(database.db, roleEnsuredDatabases);
}

export function hasEnsuredUserProfileRoleSchema(database: DatabaseSync): boolean {
  return roleEnsuredDatabases.has(database);
}
