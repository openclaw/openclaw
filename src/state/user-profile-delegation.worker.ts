import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  delegatedProfileProvider,
  isDelegatedUserSubject,
  type DelegatedUserIdentity,
} from "./user-profile-delegation.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import {
  insertUserProfile,
  requireResolvedUserProfileMetadataById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileMergeError } from "./user-profiles-schema.js";

/** OCE owns account linking. Native aliases must never acquire or move this identity. */
export function assertProfilesAreNotDelegated(db: EngineConnection, profileIds: string[]): void {
  const binding = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select("profile_id")
      .where("provider", "=", delegatedProfileProvider)
      .where("profile_id", "in", profileIds),
  );
  if (binding) {
    throw new UserProfileMergeError(
      "Delegated profiles cannot be linked or merged; link accounts in the identity authority.",
    );
  }
}

/** The existing profile worker serializes lookup and insert in one SQLite transaction. */
export function ensureDelegatedUserProfile(
  input: DelegatedUserIdentity,
  options: UserProfileMutationOptions,
) {
  if (input.authority !== "oce" || !isDelegatedUserSubject(input.subject)) {
    throw new Error("Invalid delegated user identity");
  }
  ensureUserProfilesSchema(options);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const binding = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", delegatedProfileProvider)
          .where("subject", "=", input.subject),
      );
      if (binding) {
        const profile = requireResolvedUserProfileMetadataById(db, binding.profile_id);
        if (profile.id !== binding.profile_id) {
          throw new Error("Delegated profile binding was merged");
        }
        return toUserProfile(profile);
      }
      const now = Date.now();
      const profile = insertUserProfile(
        db,
        `OCE user ${input.subject.slice(-8)}`,
        now,
        options.mutation,
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_identities").values({
          provider: delegatedProfileProvider,
          subject: input.subject,
          profile_id: profile.id,
          canonical_login: null,
          created_at: now,
        }),
      );
      options.mutation?.authority(profile.id);
      options.mutation?.identity(profile.id);
      options.mutation?.publish(profile.id);
      publishUserProfileAuthorityChange(db, profile.id);
      publishUserProfileIdentityChange(db, profile.id);
      publishUserProfilesChange(db, profile.id);
      return toUserProfile(profile);
    },
    options,
    { operationLabel: "user-profiles.delegated" },
  );
}
