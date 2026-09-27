import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { closeCachedOpenClawAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import * as verifier from "./openclaw-database-verify.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("retains admission after the last writer closes with a reader-pinned WAL", async () => {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-pinned-") },
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  let checks = 0;
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (/^PRAGMA integrity_check;?$/.test(sql)) {
          checks += 1;
        }
        return prepare(sql);
      });
    }
    return database;
  });
  const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  const quickCheck = vi.spyOn(verifier, "requestOpenClawAgentDatabaseQuickCheck");
  const write = (updatedAt: number) =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(database, "agent:main:integrity", { sessionId: "retained", updatedAt }),
      options,
    );
  write(1);
  const reader = open(pathname, { readOnly: true });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT updated_at FROM session_nodes").all();
    for (let iteration = 2; iteration <= 9; iteration += 1) {
      write(iteration);
      const database = openOpenClawAgentDatabase(options);
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      expect(database.walMaintenance.health?.state).toBe("blocked");
      expect(database.db.isOpen).toBe(false);
      await withOpenClawAgentDatabaseAsync(options, (reopened) => {
        expect(reopened.db.prepare("SELECT updated_at FROM session_nodes").get()).toEqual({
          updated_at: iteration,
        });
      });
    }
    expect(checks + worker.mock.calls.length).toBe(1);
    expect(quickCheck).not.toHaveBeenCalled();
  } finally {
    reader.close();
  }
});

it.each(["sync", "async", "admitted"] as const)(
  "checks once across writes and physical %s reopens, including after lifecycle reset",
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
    const quickCheck = vi.spyOn(verifier, "requestOpenClawAgentDatabaseQuickCheck");
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
    expect(quickCheck).not.toHaveBeenCalled();

    closeOpenClawAgentDatabasesForTest();
    openOpenClawAgentDatabase(options);
    expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
  },
);

it("retains integrity verification until durable evidence is invalidated", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-invalidation-") };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
  closeOpenClawStateDatabaseForTest();
  createUnsafeIndexDrift(databasePath);

  expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  closeOpenClawAgentDatabasesForTest();
  clearOpenClawAgentIntegrityVerification(databasePath, env);
  expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  );
});

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
