import type { DatabaseSync } from "node:sqlite";
import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";

type RevisionSelection = Pick<SkillLibrarySelection, "skillId" | "revision">;
export type SkillLibraryReadOnlyOperations = {
  "skills.library.descriptions": {
    input: readonly RevisionSelection[];
    output: Array<{ description: string } | undefined> | undefined;
  };
  "skills.library.manifests": {
    input: readonly RevisionSelection[];
    output: Array<{ files_json: string } | undefined> | undefined;
  };
};

function revisionBatchQuery(db: DatabaseSync, selections: readonly RevisionSelection[]) {
  return getNodeSqliteKysely<Pick<StateDatabase, "skill_library_revisions">>(db)
    .selectFrom("skill_library_revisions")
    .where((eb) =>
      eb.or(
        selections.map((pin) =>
          eb.and([eb("skill_id", "=", pin.skillId), eb("revision", "=", pin.revision)]),
        ),
      ),
    );
}

/** Resolve a bounded session selection in its original order, including repeated pins. */
export function selectSkillLibraryRevisionMetadataBatch(
  db: DatabaseSync,
  selections: readonly RevisionSelection[],
) {
  const rows = executeSqliteQuerySync(
    db,
    revisionBatchQuery(db, selections).select(["skill_id", "revision", "description"]),
  ).rows;
  const metadata = new Map(
    rows.map((row) => [
      JSON.stringify([row.skill_id, row.revision]),
      { description: row.description },
    ]),
  );
  return selections.map((pin) => metadata.get(JSON.stringify([pin.skillId, pin.revision])));
}

export function selectSkillLibraryRevisionManifestsBatch(
  db: DatabaseSync,
  selections: readonly RevisionSelection[],
) {
  const rows = executeSqliteQuerySync(
    db,
    revisionBatchQuery(db, selections).select(["skill_id", "revision", "files_json"]),
  ).rows;
  const manifests = new Map(
    rows.map((row) => [
      JSON.stringify([row.skill_id, row.revision]),
      { files_json: row.files_json },
    ]),
  );
  return selections.map((pin) => manifests.get(JSON.stringify([pin.skillId, pin.revision])));
}
