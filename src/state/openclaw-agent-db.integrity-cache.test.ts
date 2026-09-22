import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(["sync", "async", "admitted"] as const)(
  "checks once across writes and physical %s reopens, then checks again after lifecycle reset",
  async (mode) => {
    const options = {
      agentId: "integrity-cache",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-cache-") },
    };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const checks: string[] = [];
    const open = sqlite.openNodeSqliteDatabase;
    vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = open(...args);
      if (args[0] === pathname) {
        const prepare = database.prepare.bind(database);
        vi.spyOn(database, "prepare").mockImplementation((sql) => {
          if (/^PRAGMA (integrity_check|foreign_key_check);$/.test(sql)) {
            checks.push(sql);
          }
          return prepare(sql);
        });
      }
      return database;
    });
    const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const first = openOpenClawAgentDatabase(options);
    expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
    first.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"value\":42}', 1)");
    for (let iteration = 0; iteration < 2; iteration += 1) {
      closeOpenClawAgentDatabaseByPath(pathname);
      const read = (database: typeof first) =>
        database.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?")
          .get("preserved");
      const row =
        mode === "sync"
          ? read(openOpenClawAgentDatabase(options))
          : mode === "async"
            ? await withOpenClawAgentDatabaseAsync(options, read)
            : await withOpenClawAgentDatabaseAdmission(
                options,
                (run) => Promise.resolve(run(() => {})),
                read,
              );
      expect(row).toEqual({ state_json: '{"value":42}' });
    }
    expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
    expect(worker).not.toHaveBeenCalled();

    closeOpenClawAgentDatabasesForTest();
    openOpenClawAgentDatabase(options);
    expect(checks).toEqual([
      "PRAGMA integrity_check;",
      "PRAGMA foreign_key_check;",
      "PRAGMA integrity_check;",
      "PRAGMA foreign_key_check;",
    ]);
  },
);

it("does not lend remembered integrity to another file at the same path", () => {
  const options = {
    agentId: "integrity-cache",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-replacement-") },
  };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const replacement = `${database.path}.replacement`;
  fs.copyFileSync(database.path, replacement);
  createUnsafeIndexDrift(replacement);
  fs.renameSync(replacement, database.path);
  expect(() => openOpenClawAgentDatabase(options)).toThrow(
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  );
});
