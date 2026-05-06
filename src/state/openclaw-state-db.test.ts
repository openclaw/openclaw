import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-"));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw state database", () => {
  it("resolves under the shared state database directory", () => {
    const stateDir = createTempStateDir();

    expect(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
  });

  it("creates the initial shared state schema", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const tables = database.db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
          ORDER BY name ASC
        `,
      )
      .all()
      .map((row) => String((row as { name: unknown }).name));

    expect(tables).toEqual([
      "agents",
      "kv",
      "schema_migrations",
      "session_entries",
      "tool_artifacts",
      "transcript_events",
      "transcript_files",
      "vfs_entries",
    ]);
    expect(database.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
  });
});
