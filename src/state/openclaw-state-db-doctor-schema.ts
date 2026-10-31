import type { DatabaseSync } from "node:sqlite";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import {
  openSqliteWritableSchema,
  withSqliteWritableSchema,
} from "../infra/sqlite-schema-catalog.js";
import { invalidateSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX } from "./openclaw-state-db-schema-migration-required.js";
const LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX_SQL =
  "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)";

function normalizeSqliteCatalogSql(sql: string): string {
  return sql
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

/** Detect only the known v15 review index left behind after its column was retired. */
export function hasDanglingSkillWorkshopCollectionReviewIndex(database: DatabaseSync): boolean {
  return withSqliteWritableSchema(database, () =>
    inspectSkillWorkshopCollectionReviewIndex(database),
  );
}

function inspectSkillWorkshopCollectionReviewIndex(database: DatabaseSync): boolean {
  const index = database // sqlite-allow-raw -- Inspect the exact malformed catalog row before ordinary schema parsing.
    .prepare("SELECT tbl_name, rootpage, sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
    .get(LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX);
  if (
    index?.tbl_name !== "skill_workshop_collection_reviews" ||
    typeof index.rootpage !== "number" ||
    index.rootpage <= 0 ||
    typeof index.sql !== "string" ||
    normalizeSqliteCatalogSql(index.sql) !==
      normalizeSqliteCatalogSql(LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX_SQL)
  ) {
    return false;
  }
  const columns = database // sqlite-allow-raw -- Validate physical columns without parsing the malformed index.
    .prepare("PRAGMA table_info(skill_workshop_collection_reviews)")
    .all();
  return (
    columns.some((column) => column.name === "owner_agent_id") &&
    !columns.some((column) => column.name === "workspace_dir")
  );
}

/** Doctor can inspect the exact legacy defect before its repair transaction. */
export function openDoctorStateSchemaReadAdmission(
  database: EngineConnection,
): (() => void) | undefined {
  // PostgreSQL readers already hold catalog admission; damaged SQLite indexes do not apply.
  if (isPostgresSqlConnection(database)) {
    return undefined;
  }
  invalidateSqliteSchemaFacts(database);
  if (!hasDanglingSkillWorkshopCollectionReviewIndex(database)) {
    return undefined;
  }
  return openSqliteWritableSchema(database);
}

export { LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX };
