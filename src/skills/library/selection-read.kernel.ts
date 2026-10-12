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
function orderRevisionRows<Row extends { skill_id: string; revision: string }>(
  selections: readonly RevisionSelection[],
  rows: readonly Row[],
): Array<Omit<Row, "skill_id" | "revision"> | undefined> {
  const metadata = new Map(
    rows.map(({ skill_id, revision, ...value }) => [JSON.stringify([skill_id, revision]), value]),
  );
  return selections.map((pin) => metadata.get(JSON.stringify([pin.skillId, pin.revision])));
}

export function selectSkillLibraryRevisionMetadataBatch(
  db: DatabaseSync,
  selections: readonly RevisionSelection[],
) {
  const rows = executeSqliteQuerySync(
    db,
    revisionBatchQuery(db, selections).select(["skill_id", "revision", "description"]),
  ).rows;
  return orderRevisionRows(selections, rows);
}

export function selectSkillLibraryRevisionManifestsBatch(
  db: DatabaseSync,
  selections: readonly RevisionSelection[],
) {
  const rows = executeSqliteQuerySync(
    db,
    revisionBatchQuery(db, selections).select(["skill_id", "revision", "files_json"]),
  ).rows;
  return orderRevisionRows(selections, rows);
}
