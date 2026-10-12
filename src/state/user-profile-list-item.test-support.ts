import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { readUserProfileSnapshotSync } from "./user-profile-identity.read.js";
import { UserProfileNotFoundError } from "./user-profiles-schema.js";

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
