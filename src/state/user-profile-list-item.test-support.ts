import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import {
  userProfileDisplaySelection,
  userProfilesDb,
  toUserProfile,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileNotFoundError } from "./user-profiles-schema.js";

export function getUserProfileListItem(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const { profiles } = readUserProfileSnapshotSync(options);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profiles.find((candidate) => candidate.id === profile.mergedInto) ?? profile;
}

export function readUserProfileSnapshotSync(options: OpenClawStateDatabaseOptions = {}) {
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
            ...(tableHasColumn(database.db, "user_profiles", "role") ? (["role"] as const) : []),
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
      return {
        profiles: profiles.map((profile) =>
          Object.assign(toUserProfile(profile), {
            emails: emailsByProfile.get(profile.id) ?? [],
            githubIdentity: githubIdentities.get(profile.id) ?? null,
            hasAvatar: profile.has_avatar === 1,
          }),
        ),
      };
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.list" },
  );
}
