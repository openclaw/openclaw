import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  requireResolvedUserProfileMetadataById,
  toUserProfile,
  type UserProfileRow,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { MAX_USER_PROFILE_DISPLAY_NAME_LENGTH } from "./user-profiles.types.js";

export function normalizeProfileEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("email must not be empty");
  }
  return normalized;
}

export function insertUserProfile(
  db: DatabaseSync,
  displayName: string | null,
  now: number,
  beforeInsert?: (profileId: string) => void,
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
  beforeInsert?.(row.id);
  executeSqliteQuerySync(db, userProfilesDb(db).insertInto("user_profiles").values(row));
  return row;
}

/** The caller owns the transaction; alias uniqueness and creation settle together. */
export function ensureProfileForEmailInDatabase(
  db: DatabaseSync,
  email: string,
  initialDisplayName: string | null,
  now: number,
  beforeInsert?: (profileId: string) => void,
) {
  const kysely = userProfilesDb(db);
  const existingAlias = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("user_profile_emails").select("profile_id").where("email", "=", email),
  );
  if (existingAlias) {
    return toUserProfile(requireResolvedUserProfileMetadataById(db, existingAlias.profile_id));
  }
  const displayName =
    initialDisplayName ??
    truncateUtf16Safe(email.split("@", 1)[0] || email, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH);
  const row = insertUserProfile(db, displayName, now, beforeInsert);
  executeSqliteQuerySync(
    db,
    kysely.insertInto("user_profile_emails").values({
      email,
      profile_id: row.id,
      created_at: now,
    }),
  );
  publishUserProfilesChange(db, row.id);
  return toUserProfile(row);
}
