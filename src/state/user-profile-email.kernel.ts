import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { publishUserProfilesChange } from "./user-profile-list.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import {
  insertUserProfile,
  requireResolvedUserProfileMetadataById,
  selectUserProfileEmailAlias,
  setUserProfileEmailBinding,
  toUserProfile,
} from "./user-profiles-internal.js";
import { MAX_USER_PROFILE_DISPLAY_NAME_LENGTH } from "./user-profiles.types.js";

export function normalizeProfileEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("email must not be empty");
  }
  return normalized;
}

/** The caller owns the transaction; alias uniqueness and creation settle together. */
export function ensureProfileForEmailInDatabase(
  db: DatabaseSync,
  email: string,
  initialDisplayName: string | null,
  now: number,
  mutation?: UserProfileMutationContext,
) {
  const existingAlias = selectUserProfileEmailAlias(db, email);
  if (existingAlias) {
    return toUserProfile(requireResolvedUserProfileMetadataById(db, existingAlias.profile_id));
  }
  const displayName =
    initialDisplayName ??
    truncateUtf16Safe(email.split("@", 1)[0] || email, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH);
  const row = insertUserProfile(db, displayName, now, mutation);
  setUserProfileEmailBinding(db, email, row.id, now);
  mutation?.authority(row.id);
  mutation?.publish(row.id);
  publishUserProfilesChange(db, row.id);
  return toUserProfile(row);
}
