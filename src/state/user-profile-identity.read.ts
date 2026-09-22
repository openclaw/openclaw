import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { selectResolvedUserProfileMetadataById, userProfilesDb } from "./user-profiles-internal.js";

/** Alias lookup is observational and never initializes profile storage. */
export function readUserProfileIdForEmail(db: DatabaseSync, email: string): string | undefined {
  if (!tableExists(db, "user_profile_emails") || !tableExists(db, "user_profiles")) {
    return undefined;
  }
  const alias = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", email),
  );
  return alias ? selectResolvedUserProfileMetadataById(db, alias.profile_id)?.id : undefined;
}
