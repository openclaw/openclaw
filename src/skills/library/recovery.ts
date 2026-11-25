import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { selectUserProfileIdentityInDatabase } from "../../state/user-profile-identity.read.js";
import { assertSkillLibraryNameAvailable, skillLibraryDb } from "./store.js";

export type SkillLibraryRecovery = {
  entry: Selectable<DB["skill_library_entries"]>;
  revision: Selectable<DB["skill_library_revisions"]>;
};

/** Recheck current canonical ownership before offline artifact and database effects. */
export function assertSkillLibraryRecoveryOwnerInDatabase(
  db: EngineConnection,
  source: SkillLibraryRecovery,
  profileId: string,
) {
  const identity = selectUserProfileIdentityInDatabase(db, profileId);
  if (
    !identity ||
    identity.profileId !== profileId ||
    source.entry.owner_profile_id === null ||
    !identity.aliases.has(source.entry.owner_profile_id)
  ) {
    throw new Error(
      "Selected skill owner is not a current profile or its existing canonical alias",
    );
  }
  const query = skillLibraryDb(db);
  const entry = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("skill_library_entries")
      .selectAll()
      .where("skill_id", "=", source.entry.skill_id),
  );
  if (
    entry &&
    (entry.owner_profile_id === null ||
      !identity.aliases.has(entry.owner_profile_id) ||
      entry.slug !== source.entry.slug ||
      entry.removed !== 0)
  ) {
    throw new Error("Existing skill ownership, name, or removal conflicts with recovery");
  }
  return entry;
}

/** Offline repair restores content, never historical sharing, defaults, identities, or roles. */
export function restoreSkillLibraryRevisionInDatabase(
  db: EngineConnection,
  source: SkillLibraryRecovery,
  profileId: string,
) {
  const entry = assertSkillLibraryRecoveryOwnerInDatabase(db, source, profileId);
  const query = skillLibraryDb(db);
  const revision = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("skill_library_revisions")
      .selectAll()
      .where("skill_id", "=", source.entry.skill_id)
      .where("revision", "=", source.revision.revision),
  );
  if (revision && !isDeepStrictEqual({ ...revision }, { ...source.revision })) {
    throw new Error("Existing skill revision conflicts with recovery");
  }
  if (!entry) {
    assertSkillLibraryNameAvailable(db, profileId, source.entry.slug, source.entry.skill_id);
    executeSqliteQuerySync(
      db,
      query.insertInto("skill_library_entries").values({
        ...source.entry,
        owner_profile_id: profileId,
        author_profile_id: profileId,
        current_revision: source.revision.revision,
        shared: 0,
        enabled: 0,
        removed: 0,
      }),
    );
  }
  if (!revision) {
    executeSqliteQuerySync(db, query.insertInto("skill_library_revisions").values(source.revision));
  }
  return { skillRestored: !entry || !revision };
}
