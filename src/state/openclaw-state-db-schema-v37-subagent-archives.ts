import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { withLegacyStateHeadLayout } from "./openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "./openclaw-state-db-schema-v27-indexes.js";
import { withLegacyLocalWorkspaceManifests } from "./openclaw-state-db-schema-v31-workspace-manifests.js";
import { withLegacyLocalWorkspaceCas } from "./openclaw-state-db-schema-v35-workspace-cas.js";
import { withLegacyTemplateStateSchema } from "./openclaw-state-db-schema-v36-template-names.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export const stateSubagentArchivesMigration = {
  version: 37,
  tables: ["subagent_run_archives"],
  columns: [],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 37) {
      return false;
    }
    // sqlite-allow-raw -- The migration only creates empty canonical archive storage.
    db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "subagent_run_archives"));
    return true;
  },
  applied: "Prepared bounded kept-subagent run archive storage (v37)",
};

/** Preserve the exact pre-archive catalog for migration admission and backups. */
export function withoutSubagentRunArchives(schema: string): string {
  return schema
    .replace(
      /CREATE TABLE(?: IF NOT EXISTS)? "?subagent_run_archives"? \([\s\S]*?\n\)(?: STRICT)?;\n?/gu,
      "",
    )
    .replace(/CREATE INDEX(?: IF NOT EXISTS)? "?idx_subagent_run_archives_\w+"?[\s\S]*?;\n?/gu, "");
}

/** Reconstruct the predecessor catalog before admitting a bounded migration. */
export function stateSchemaBeforeArchiveMigration(previousVersion: number): string {
  let schema = OPENCLAW_STATE_SCHEMA_SQL;
  for (const [version, transform] of [
    [37, withoutSubagentRunArchives],
    [36, withLegacyTemplateStateSchema],
    [35, withLegacyLocalWorkspaceCas],
    [31, withLegacyLocalWorkspaceManifests],
    [27, withLegacyStateWriteIndexes],
    [26, withLegacyStateHeadLayout],
  ] as const) {
    if (previousVersion < version) {
      schema = transform(schema);
    }
  }
  return schema;
}

export function subagentArchivesPostgresMigration(schema: string): string {
  return (
    schema.match(
      /CREATE TABLE "subagent_run_archives" \([\s\S]*?\n\);|CREATE INDEX "idx_subagent_run_archives_\w+" [^;]+;/gu,
    ) ?? []
  ).join("\n\n");
}
