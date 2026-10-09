import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

/** Model a future release whose catalog this build cannot interpret. */
export function writeUnreadableNewerStateSchema(databasePath: string) {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (
        review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL,
        backup_id TEXT NOT NULL, create_time INTEGER NOT NULL,
        kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL,
        dropped_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
        ON skill_workshop_collection_reviews(review_id, create_time DESC);
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON");
    database
      .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'index' AND name = ?")
      .run(
        "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)",
        "idx_skill_workshop_collection_reviews_workspace_time",
      );
    const schema = database.prepare("PRAGMA schema_version").get();
    database.exec(
      `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${Number(schema?.schema_version) + 1}`,
    );
  } finally {
    database.close();
  }
}

/** Capture persistent artifacts without releasing the test writer's POSIX locks. */
export function snapshotPreflightSourceManifest(stateDir: string, allowAgentReadMarks?: string) {
  // Opening/closing the main file in the writer's process releases its POSIX
  // locks. Observe in a child so SQLite still sees a live owner during inspection.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import fs from "node:fs";
      import path from "node:path";
      import { createHash } from "node:crypto";
      const [stateDir, allowAgentReadMarks] = process.argv.slice(1);
      const manifest = fs.readdirSync(stateDir, { recursive: true, encoding: "utf8" })
        .filter(entry => !entry.startsWith("tmp" + path.sep))
        .filter(entry => fs.statSync(path.join(stateDir, entry)).isFile())
        .toSorted().map(entry => {
          const pathname = path.join(stateDir, entry);
          const bytes = fs.readFileSync(pathname);
          if (pathname === allowAgentReadMarks + "-shm") bytes.fill(0, 100, 120);
          return [entry, createHash("sha256").update(bytes).digest("hex")];
        });
      console.log(JSON.stringify(manifest));
      `,
      stateDir,
      allowAgentReadMarks ?? "",
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

export function snapshotSourceFamily(databasePath: string) {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(fs.existsSync);
  return {
    entries: fs.readdirSync(path.dirname(databasePath)).toSorted(),
    files: paths.map((pathname) => {
      const stat = fs.statSync(pathname, { bigint: true });
      return {
        pathname,
        bytes: fs.readFileSync(pathname),
        birthtimeNs: stat.birthtimeNs,
        ctimeNs: stat.ctimeNs,
        dev: stat.dev,
        ino: stat.ino,
        mtimeNs: stat.mtimeNs,
        size: stat.size,
      };
    }),
  };
}
