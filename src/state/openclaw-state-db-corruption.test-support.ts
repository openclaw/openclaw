import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

export function createDanglingSkillWorkshopReviewIndex(databasePath: string): number {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
    );
    const index = database
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = 'idx_skill_workshop_collection_reviews_workspace_time'",
      )
      .get() as { rootpage?: number } | undefined;
    if (typeof index?.rootpage !== "number") {
      throw new Error("failed to create legacy Skill Workshop review index fixture");
    }
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                         ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
          WHERE type = 'index'
            AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
    return index.rootpage;
  } finally {
    database.close();
  }
}

export function readDanglingSkillWorkshopReviewIndex(
  databasePath: string,
): { rootpage: number; sql: string } | undefined {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    return database
      .prepare(
        "SELECT rootpage, sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_skill_workshop_collection_reviews_workspace_time'",
      )
      .get() as { rootpage: number; sql: string } | undefined;
  } finally {
    database.close();
  }
}

export function createCorruptionRefusalStateDatabaseFixture(prepareTemplate: () => string) {
  let templatePath: string | undefined;
  return (stateDir: string): string => {
    if (!templatePath) {
      const preparedPath = prepareTemplate();
      createUnsafeIndexDrift(preparedPath);
      createDanglingSkillWorkshopReviewIndex(preparedPath);
      // Clone closed bytes before each refusal scenario adds its own WAL or quarantine state.
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (fs.existsSync(`${preparedPath}${suffix}`)) {
          throw new Error(`corruption refusal template retained ${suffix} sidecar`);
        }
      }
      templatePath = preparedPath;
    }
    const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.copyFileSync(templatePath, databasePath);
    return databasePath;
  };
}
