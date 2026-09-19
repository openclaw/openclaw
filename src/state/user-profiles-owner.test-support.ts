import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { seedUserProfileRole } from "./user-profiles.test-support.js";

export function profileState(options: OpenClawStateDatabaseOptions) {
  const db = openOpenClawStateDatabase(options).db;
  return {
    profiles: db.prepare("SELECT * FROM user_profiles ORDER BY id").all(),
    emails: db.prepare("SELECT * FROM user_profile_emails ORDER BY email").all(),
    identities: db
      .prepare("SELECT * FROM user_profile_identities ORDER BY provider, subject")
      .all(),
  };
}

export function mergeOwnerIntoPerson(ownerId: string, options: OpenClawStateDatabaseOptions) {
  const person = ensureProfileForEmail("person@example.test", options);
  seedUserProfileRole(person.id, "guest", options);
  openOpenClawStateDatabase(options)
    .db.prepare("UPDATE user_profiles SET merged_into = ?, updated_at = 1 WHERE id = ?")
    .run(person.id, ownerId);
  return person;
}
