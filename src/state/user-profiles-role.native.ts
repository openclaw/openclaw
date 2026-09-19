import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import { writeUserProfileRole } from "./user-profiles-role.kernel.js";
import { ensureUserProfileRoleSchema } from "./user-profiles-schema.js";

/** Shipped opaque SDK guards may read SQLite and must stay beside the native write. */
export function setNativeUserProfileRole(
  params: { profileId: string; role: string | null; assertCurrent: () => void },
  options: OpenClawStateDatabaseOptions = {},
) {
  params.assertCurrent();
  ensureUserProfileRoleSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = writeUserProfileRole(
        db,
        params.profileId,
        params.role,
        Date.now(),
        params.assertCurrent,
      );
      publishUserProfilesChange(db, profile.id);
      return profile;
    },
    options,
    { operationLabel: "user-profiles.set-role" },
  );
}
