import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";

const LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX =
  "idx_skill_workshop_collection_reviews_workspace_time";
const LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX_SQL =
  "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)";

function normalizeSqliteCatalogSql(sql: string): string {
  return sql
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

export function withSqliteWritableSchema<T>(database: DatabaseSync, operation: () => T): T {
  database.enableDefensive?.(false);
  // sqlite-allow-raw -- Exact legacy catalog admission requires SQLite's writable-schema pragma.
  database.exec("PRAGMA writable_schema = ON;");
  try {
    return operation();
  } finally {
    try {
      // sqlite-allow-raw -- Always restore catalog parsing after the bounded legacy inspection.
      database.exec("PRAGMA writable_schema = OFF;");
    } finally {
      database.enableDefensive?.(true);
    }
  }
}

/** Detect only the known v15 review index left behind after its column was retired. */
export function hasDanglingSkillWorkshopCollectionReviewIndex(database: DatabaseSync): boolean {
  return withSqliteWritableSchema(database, () => {
    const rawIndex = database // sqlite-allow-raw -- Inspect the exact malformed catalog row before ordinary schema parsing.
      .prepare(
        "SELECT tbl_name, rootpage, sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
      )
      .get(LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX);
    // SAFETY: the narrow catalog projection is validated field-by-field below.
    const index = rawIndex as { tbl_name?: unknown; rootpage?: unknown; sql?: unknown } | undefined;
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
    const rawColumns = database // sqlite-allow-raw -- Validate physical columns without parsing the malformed index.
      .prepare("PRAGMA table_info(skill_workshop_collection_reviews)")
      .all();
    // SAFETY: PRAGMA table_info rows expose optional names compared as unknown values.
    const columns = rawColumns as Array<{ name?: unknown }>;
    return (
      columns.some((column) => column.name === "owner_agent_id") &&
      !columns.some((column) => column.name === "workspace_dir")
    );
  });
}

/** Keep a read-only connection tolerant of the exact malformed legacy index. */
export function openDanglingWorkshopIndexReadAdmission(
  database: DatabaseSync,
): (() => void) | undefined {
  if (!hasDanglingSkillWorkshopCollectionReviewIndex(database)) {
    return undefined;
  }
  database.enableDefensive?.(false);
  try {
    // sqlite-allow-raw -- Hold exact legacy catalog admission for a bounded read-only operation.
    database.exec("PRAGMA writable_schema = ON;");
  } catch (error) {
    database.enableDefensive?.(true);
    throw error;
  }
  let open = true;
  return () => {
    if (!open) {
      return;
    }
    open = false;
    try {
      // sqlite-allow-raw -- Restore ordinary schema parsing before releasing the read-only handle.
      database.exec("PRAGMA writable_schema = OFF;");
    } finally {
      database.enableDefensive?.(true);
    }
  };
}

/** Restore schema parsing and release a private read handle even if either cleanup fails. */
export function closeWorkshopIndexReadDatabase(
  database: DatabaseSync,
  closeAdmission?: () => void,
): void {
  try {
    closeAdmission?.();
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

export { LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX };
