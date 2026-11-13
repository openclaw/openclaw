import {
  assertDeviceBootstrapPersonalSelection,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { selectResolvedUserProfileById } from "../state/user-profiles-internal.js";
import type { EngineConnection } from "./sql-connection.js";

/** The issuing/pairing transaction rereads the exact selection; aliases cannot retarget a grant. */
export function assertBootstrapPersonInDatabase(
  db: EngineConnection,
  profile: DeviceBootstrapProfile,
): void {
  assertDeviceBootstrapPersonalSelection(profile);
  if (profile.operatorProfileId === undefined) {
    return;
  }
  const person = selectResolvedUserProfileById(db, profile.operatorProfileId);
  if (!person || person.id !== profile.operatorProfileId || person.merged_into) {
    throw new Error("Bootstrap requires the exact current personal profile");
  }
}
