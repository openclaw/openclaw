import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { mergeUserGitHubConnection } from "./user-github-connections.js";
import { mergeUserModelAccounts } from "./user-model-accounts.js";
import { mergeUserPreferences } from "./user-preferences.store.js";
import {
  publishUserProfileAliasChange,
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { prepareUserProfileGitHubMerge } from "./user-profile-github-identity.js";
import { stageUserProfileCatalogChange } from "./user-profile-list.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import { requireResolvedUserProfileById, userProfilesDb } from "./user-profiles-internal.js";

export function mergeUserProfiles(
  db: DatabaseSync,
  sourceProfileId: string,
  targetProfileId: string,
  now: number,
  mutation?: UserProfileMutationContext,
): void {
  if (sourceProfileId === targetProfileId) {
    return;
  }
  const kysely = userProfilesDb(db);
  const sourceProfileIds = [
    sourceProfileId,
    ...executeSqliteQuerySync(
      db,
      kysely.selectFrom("user_profiles").select("id").where("merged_into", "=", sourceProfileId),
    ).rows.map((row) => row.id),
  ];
  mutation?.before(db, ...sourceProfileIds, targetProfileId);
  prepareUserProfileGitHubMerge(db, sourceProfileIds, targetProfileId);
  const source = requireResolvedUserProfileById(db, sourceProfileId);
  if (source.avatar !== null) {
    // Explicit profile linking preserves the target portrait, or carries the source upload.
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("user_profiles")
        .set({
          avatar: source.avatar,
          avatar_mime: source.avatar_mime,
          avatar_sha256: source.avatar_sha256,
        })
        .where("id", "=", targetProfileId)
        .where("avatar", "is", null),
    );
  }
  mergeUserModelAccounts(db, sourceProfileId, targetProfileId);
  mergeUserGitHubConnection(db, sourceProfileId, targetProfileId);
  for (const mergedProfileId of sourceProfileIds) {
    mergeUserPreferences(db, mergedProfileId, targetProfileId);
  }
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("user_profile_emails")
      .set({ profile_id: targetProfileId })
      .where("profile_id", "in", sourceProfileIds),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("user_profile_identities")
      .set({ profile_id: targetProfileId })
      .where("profile_id", "in", sourceProfileIds),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("user_profiles")
      .set({ merged_into: targetProfileId, updated_at: now })
      .where("id", "in", sourceProfileIds),
  );
  executeSqliteQuerySync(
    db,
    kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", targetProfileId),
  );
  stageUserProfileCatalogChange(db, sourceProfileIds);
  mutation?.publish(...sourceProfileIds, targetProfileId);
  mutation?.authority(...sourceProfileIds, targetProfileId);
  mutation?.identity(...sourceProfileIds);
  publishUserProfileAuthorityChange(db, ...sourceProfileIds, targetProfileId);
  publishUserProfileIdentityChange(db, ...sourceProfileIds);
  deferSqlitePostCommitPublication(db, publishUserProfileAliasChange);
}
