import type { DatabaseSync } from "node:sqlite";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { selectUserProfileListItemById } from "./user-profile-list-item.js";
import {
  requireResolvedUserProfileMetadataById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";

/** Both transports resolve and protect the target on their transaction connection. */
export function writeUserProfileRole(
  db: DatabaseSync,
  profileId: string,
  role: string | null,
  now: number,
  beforeWrite?: (canonicalProfileId: string) => void,
) {
  const profile = requireResolvedUserProfileMetadataById(db, profileId);
  if (profileId === GATEWAY_OWNER_PROFILE_ID || profile.id === GATEWAY_OWNER_PROFILE_ID) {
    throw new UserProfileOwnerError("role");
  }
  beforeWrite?.(profile.id);
  executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .updateTable("user_profiles")
      .set({ role, updated_at: now })
      .where("id", "=", profile.id),
  );
  return selectUserProfileListItemById(db, profile.id);
}
