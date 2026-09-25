import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  inspectProfileAvatarInDatabase,
  readProfileAvatarInDatabase,
} from "./user-profiles-internal.js";

export function getProfileAvatar(profileId: string, options: OpenClawStateDatabaseOptions = {}) {
  const { db } = openOpenClawStateDatabase(options);
  const { profile, avatar } = inspectProfileAvatarInDatabase(db, profileId);
  return profile && avatar
    ? readProfileAvatarInDatabase(db, profileId, {
        canonicalProfileId: profile.id,
        sha256: avatar.sha256,
        mime: avatar.mime,
      })
    : undefined;
}
