import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { loadExactSessionEntryCandidatesReadOnlyBatch } from "./session-accessor.sqlite-exact-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("exact SQLite session batch availability", () => {
  it.each(["session_key_contract", "session_nodes"])(
    "preserves table-missing (%s) outcomes for every requested key",
    (table) => {
      const scope = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-unavailable-") },
      };
      const { db, path: databasePath } = openOpenClawAgentDatabase(scope);
      clearNodeSqliteKyselyCacheForDatabase(db);
      const prepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.includes(`from "${table}"`)) {
          // Lose the table after schema admission, before reading its metadata.
          prepareSpy.mockRestore();
          db.exec(`DROP TABLE ${table}`);
        }
        return prepare(sql);
      });
      const healthy = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-available-") },
      };
      openOpenClawAgentDatabase(healthy);
      const results = loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, sessionKeys: ["agent:main:first"] },
        { ...healthy, sessionKeys: ["agent:main:absent"] },
        { ...scope, sessionKeys: ["agent:main:second"] },
      ]);
      const expected = {
        ok: false,
        error: {
          name: "SessionMetadataUnavailableError",
          reason: "table-missing",
          cause: { code: "ERR_SQLITE_ERROR" },
          missingTables: [table],
        },
      };
      expect(results).toMatchObject([expected, { ok: true, value: [] }, expected]);
      expect(fs.existsSync(databasePath)).toBe(true);
    },
  );

  it("keeps a present empty store and an empty key request successful", () => {
    const scope = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-empty-") },
    };
    openOpenClawAgentDatabase(scope);
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, sessionKeys: ["agent:main:absent"] },
        { ...scope, sessionKeys: [" "] },
      ]),
    ).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
  });
});
