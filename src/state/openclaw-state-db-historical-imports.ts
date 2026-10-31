import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { readSqliteSchemaObjects } from "../infra/sqlite-schema-admission.js";
import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import { createSqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema, quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { migrateHistoricalImageReserveSnapshots } from "./openclaw-state-db-image-snapshot-migration.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  migratePredicateColumnsV21,
  statePredicateColumnMigration,
} from "./openclaw-state-db-schema-v21-columns.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const table = "worker_session_placements";
const archivalColumn = "repository_preparation TEXT";
const preparationCheck =
  "CHECK (repository_preparation IS NULL OR " +
  "(repository_preparation = 'ready' AND workspace_base_manifest_ref IS NOT NULL) OR " +
  "(repository_preparation = 'failed' AND state IN ('starting', 'active', 'draining', 'reconciling', 'reclaimed', 'failed')) OR " +
  "(repository_preparation = 'pending' AND workspace_base_manifest_ref IS NULL " +
  "AND state IN ('starting', 'active', 'draining', 'reconciling', 'reclaimed', 'failed')))";

/** Only the recognized historical contract may surrender its incomplete-preparation exception. */
function migrateHistoricalRepositoryPreparation(db: DatabaseSync): boolean {
  if (!tableHasColumn(db, table, "repository_preparation")) {
    return false;
  }
  const canonical = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table).replace(
    "  remote_workspace_dir TEXT,",
    "  " + archivalColumn + ",\n  remote_workspace_dir TEXT,",
  );
  const actual = createSqliteTableContractReader(db)(table);
  const target = parseSqliteTableDefinition(canonical, table);
  if (
    actual?.strict === 1 &&
    actual.withoutRowid === 0 &&
    isDeepStrictEqual(actual.definition, target)
  ) {
    return false;
  }
  const historical = canonical
    .replace(
      archivalColumn + ",",
      archivalColumn + " CHECK (repository_preparation IN ('pending', 'ready', 'failed')),",
    )
    .replace("  CHECK (\n    (state IN", "  " + preparationCheck + ",\n  CHECK (\n    (state IN")
    .replaceAll(
      "AND workspace_base_manifest_ref IS NOT NULL AND remote_workspace_dir",
      "AND (workspace_base_manifest_ref IS NOT NULL OR repository_preparation IS 'pending' OR repository_preparation IS 'failed') AND remote_workspace_dir",
    );
  if (
    !actual ||
    actual.strict !== 1 ||
    actual.withoutRowid !== 0 ||
    !isDeepStrictEqual(actual.definition, parseSqliteTableDefinition(historical, table))
  ) {
    throw new Error(
      "Unrecognized historical worker placement schema; preserve the store for explicit recovery.",
    );
  }
  // The predecessor-only column is deliberately absent from the current DB type.
  const claimed = /* sqlite-allow-raw: Offline predecessor claim admission. */ db
    .prepare(
      "SELECT 1 FROM worker_session_placements WHERE repository_preparation IN ('pending', 'failed') AND turn_claim_owner = 'worker' LIMIT 1",
    )
    .get();
  if (claimed) {
    throw new Error(
      "Historical repository preparation retains a worker turn claim; reconcile its owned cleanup before migrating.",
    );
  }
  const objects = readSqliteSchemaObjects(db).filter(
    (object) =>
      object.tbl_name === table &&
      (object.type === "index" || object.type === "trigger") &&
      object.sql !== null,
  );
  const columns = actual.columns.map((column) => column.name);
  const select = columns.map((column) => {
    if (column === "state") {
      return "CASE WHEN repository_preparation IN ('pending', 'failed') THEN 'failed' ELSE state END";
    }
    if (column === "recovery_error") {
      return (
        "CASE WHEN repository_preparation IN ('pending', 'failed') THEN 'Historical repository preparation ' || repository_preparation || " +
        "' (previous placement ' || state || '); owned cleanup required before recovery.' || " +
        "CASE WHEN recovery_error IS NULL THEN '' ELSE ' ' || recovery_error END ELSE recovery_error END"
      );
    }
    return quoteSqliteIdentifier(column);
  });
  const temporary = table + "_historical_migration";
  // The enclosing owner suspends foreign keys before BEGIN and validates them before COMMIT.
  // Keep rowids, every custody field and original attached objects; no claim is retired here.
  // sqlite-allow-raw -- Offline, transactional conversion of a recognized predecessor contract.
  db.exec(
    canonical.replace("CREATE TABLE IF NOT EXISTS " + table, "CREATE TABLE " + temporary) +
      " INSERT INTO " +
      temporary +
      " (rowid, " +
      columns.map(quoteSqliteIdentifier).join(", ") +
      ") SELECT rowid, " +
      select.join(", ") +
      " FROM " +
      table +
      ";" +
      " DROP TABLE " +
      table +
      "; ALTER TABLE " +
      temporary +
      " RENAME TO " +
      table +
      ";",
  );
  for (const object of objects) {
    if (typeof object.sql !== "string") {
      throw new Error("Historical worker placement schema object is invalid");
    }
    // sqlite-allow-raw -- Restore the original table's indexes/triggers inside its rebuild transaction.
    db.exec(object.sql);
  }
  return true;
}

/** Both bounded version publication and full Doctor repair retain the same historical owners. */
export function migrateHistoricalStateImports(
  db: DatabaseSync,
  previousVersion: number,
  scope: "version" | "doctor" = "version",
): string[] {
  // Later bounded upgrades must not mutate tables outside their declared backup scope.
  if (scope === "version" && previousVersion > 22) {
    return [];
  }
  const changes: string[] = [];
  // The archival placement contract belongs to the v21 import, not later scoped upgrades.
  const placements = previousVersion === 21 && migrateHistoricalRepositoryPreparation(db);
  if (placements) {
    changes.push(
      "Preserved historical worker placement evidence and fenced incomplete repository preparation",
    );
  }
  if ((previousVersion === 21 || placements) && migratePredicateColumnsV21(db, 21)) {
    changes.push(statePredicateColumnMigration.applied);
  }
  if (scope === "doctor" || previousVersion <= 22) {
    changes.push(...migrateHistoricalImageReserveSnapshots(db));
  }
  return changes;
}
