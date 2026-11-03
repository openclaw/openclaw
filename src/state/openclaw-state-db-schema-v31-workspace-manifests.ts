import type { DatabaseSync } from "node:sqlite";
import { captureSqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema, quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { ensureColumn, readTableColumns, tableExists } from "./openclaw-state-db-schema-helpers.js";
import { withLegacyLocalWorkspaceCas } from "./openclaw-state-db-schema-v35-workspace-cas.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const projectionTable = "local_workspace_projections";
const nodeTable = "local_workspace_manifest_nodes";
const legacyBaselineCheck = "CHECK ((baseline_json IS NULL) = (baseline_ref IS NULL))";
const incrementalBaselineCheck = "CHECK (baseline_json IS NULL OR baseline_ref IS NOT NULL)";

/** The schema transaction preserves legacy bytes; the projection owner converts each baseline. */
function migrateLocalWorkspaceManifests(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 31 || !tableExists(db, projectionTable)) {
    return false;
  }
  ensureColumn(db, projectionTable, "checkpoint_json TEXT");
  const schema = getAdmittedSqliteSchemaFacts(db) ?? captureSqliteSchemaFacts(db);
  const create = schema.tableSql.get(projectionTable);
  if (typeof create !== "string") {
    throw new Error("Local workspace projection migration schema is missing");
  }
  if (create.includes(legacyBaselineCheck)) {
    const temporary = quoteSqliteIdentifier(`${projectionTable}_migration_v31`);
    const name = quoteSqliteIdentifier(projectionTable);
    const columns = [...readTableColumns(db, projectionTable)]
      .map(quoteSqliteIdentifier)
      .join(", ");
    // Preserve added columns and the table's own indexes/triggers while relaxing
    // the legacy JSON requirement. The schema owner has disabled foreign keys.
    const declaration = create
      .slice(create.indexOf("("))
      .replace(legacyBaselineCheck, incrementalBaselineCheck);
    // sqlite-allow-raw -- Versioned table rebuild inside the shared schema transaction.
    db.exec(`CREATE TABLE ${temporary} ${declaration};
      INSERT INTO ${temporary} (rowid, ${columns}) SELECT rowid, ${columns} FROM ${name};
      DROP TABLE ${name};
      ALTER TABLE ${temporary} RENAME TO ${name};`);
    for (const object of [...schema.indexDefinitions.values(), ...schema.triggers.values()]) {
      if (object.table === projectionTable && typeof object.sql === "string") {
        // sqlite-allow-raw -- Restore the rebuilt table's captured local definitions.
        db.exec(object.sql);
      }
    }
  } else if (!create.includes(incrementalBaselineCheck)) {
    throw new Error(
      "Local workspace baseline constraint is not recognized; preserve it for Doctor",
    );
  }
  // sqlite-allow-raw -- The existing feature remains absent until its first use.
  db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, nodeTable));
  return true;
}

export const stateLocalWorkspaceManifestMigration = {
  version: 31,
  tables: [projectionTable, nodeTable],
  columns: [`${projectionTable}.checkpoint_json`],
  migrate: migrateLocalWorkspaceManifests,
  applied: "Prepared resumable per-path local workspace baselines and checkpoint deltas (v31)",
};

/** Keep exact predecessor declarations for SQLite admission and PostgreSQL backups. */
export function withLegacyLocalWorkspaceManifests(schema: string): string {
  return withLegacyLocalWorkspaceCas(schema)
    .replace(/\n {2}(?:checkpoint_json TEXT|"checkpoint_json" text COLLATE "C"),/gu, "")
    .replace(/^ {2}CHECK \([^\n]*baseline_json[^\n]*baseline_ref[^\n]*\),$/gmu, (check) =>
      check.includes('"')
        ? '  CHECK ((("baseline_json" IS NULL) = ("baseline_ref" IS NULL))),'
        : `  ${legacyBaselineCheck},`,
    )
    .replace(
      /CREATE TABLE(?: IF NOT EXISTS)? "?local_workspace_manifest_nodes"? \([\s\S]*?\n\)(?: STRICT)?;\n?/gu,
      "",
    )
    .replace(/ALTER TABLE "local_workspace_manifest_nodes" ADD FOREIGN KEY[^;]*;\n?/gu, "");
}
