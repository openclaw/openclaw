import {
  runOpenClawStateWriteTransaction,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import { writeUserProfileRole } from "./user-profiles-role.kernel.js";
import { ensureUserProfileRoleSchema } from "./user-profiles-schema.js";
import { ensureProfileForEmail } from "./user-profiles.js";

/** Seed native profile state while preserving transaction and publication behavior. */
export function seedUserProfileRole(
  profileId: string,
  role: string | null,
  options: OpenClawStateDatabaseOptions = {},
) {
  ensureUserProfileRoleSchema(options);
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = writeUserProfileRole(db, profileId, role, now);
      publishUserProfilesChange(db, profile.id);
      return profile;
    },
    options,
    { operationLabel: "user-profiles.seed-role" },
  );
}

/** Reproduce the optional-column upgrade contract without running a migration first. */
export function createLegacyUserProfilesTable(options: OpenClawStateDatabaseOptions = {}) {
  const database = openOpenClawStateDatabase(options).db;
  database.exec(`
    CREATE TABLE user_profiles (
      id TEXT NOT NULL PRIMARY KEY,
      display_name TEXT,
      avatar BLOB,
      avatar_mime TEXT,
      avatar_sha256 TEXT,
      merged_into TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  return database;
}

/** Create an identified caller with a durable role before starting the tested flow. */
export function seedProfileForRole(
  email: string,
  role: string | null,
  options: OpenClawStateDatabaseOptions = {},
) {
  return seedUserProfileRole(ensureProfileForEmail(email, options).id, role, options);
}
