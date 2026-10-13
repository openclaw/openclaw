import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";

const templates = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanup();
  });
});
let templatePath: string;

beforeAll(async () => {
  const env = { OPENCLAW_STATE_DIR: templates.make("agent-integrity-recovery-template-") };
  templatePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

it.each(["readonly", "async"] as const)(
  "invalidates generation-bound schema refusals during %s admission",
  async (admission) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-schema-recovery-") };
    const options = { agentId: "worker-1", env };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.copyFileSync(templatePath, pathname, fs.constants.COPYFILE_EXCL);
    const failure = new Error("unsupported schema generation");
    failure.name = "SqliteSchemaVersionError";
    recordOpenClawAgentDatabaseOpenFailure(
      pathname,
      failure,
      readStableSqliteFileGeneration(pathname),
    );
    const open = async () => {
      if (admission === "async") {
        await withOpenClawAgentDatabaseAsync(options, () => undefined);
      } else {
        const result = openOpenClawAgentDatabaseReadOnly(options);
        expect(result.found).toBe(true);
        if (result.found) {
          result.database.close();
        }
      }
    };
    await expect(open()).rejects.toBe(failure);
    const changed = new (requireNodeSqlite().DatabaseSync)(pathname);
    try {
      changed.exec("PRAGMA application_id = 1;");
    } finally {
      changed.close();
    }
    await expect(open()).resolves.toBeUndefined();
  },
);

it.each(["writable", "readonly", "async"] as const)(
  "refuses orphan rows and recovers %s admission after external repair",
  async (admission) => {
    const stateDir = tempDirs.make("agent-integrity-recovery-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "worker-1", env });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.copyFileSync(templatePath, databasePath, fs.constants.COPYFILE_EXCL);

    const { DatabaseSync } = requireNodeSqlite();
    const corrupted = new DatabaseSync(databasePath);
    try {
      corrupted.exec("PRAGMA foreign_keys = OFF;");
      corrupted
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("orphan-window", "missing-node", 1, 1);
      expect(corrupted.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(corrupted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(corrupted.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "session_windows",
        rowid: 1,
        parent: "session_nodes",
        fkid: 1,
      });
    } finally {
      corrupted.close();
    }

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /foreign_key_check failed.*session_windows row 1 references session_nodes \(foreign key 1\)/iu,
    );
    if (admission === "readonly") {
      const failure = new Error("foreign_key_check failed before external repair");
      failure.name = "SqliteIntegrityError";
      recordOpenClawAgentDatabaseOpenFailure(
        databasePath,
        failure,
        readStableSqliteFileGeneration(databasePath),
      );
      const changed = new DatabaseSync(databasePath);
      try {
        changed.prepare("UPDATE session_windows SET updated_at = 2").run();
      } finally {
        changed.close();
      }
    }
    const open = async () => {
      if (admission === "readonly") {
        const result = openOpenClawAgentDatabaseReadOnly({ agentId: "worker-1", env });
        expect(result.found).toBe(true);
        if (result.found) {
          result.database.close();
        }
      } else if (admission === "async") {
        await withOpenClawAgentDatabaseAsync({ agentId: "worker-1", env }, () => undefined);
      } else {
        openOpenClawAgentDatabase({ agentId: "worker-1", env });
      }
    };
    await expect(open()).rejects.toThrow("foreign_key_check failed");
    // External repair changes persisted rows without clearing this process's latch.
    const repaired = new DatabaseSync(databasePath);
    try {
      repaired.prepare("DELETE FROM session_windows WHERE session_id = ?").run("orphan-window");
      expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      repaired.close();
    }
    await expect(open()).resolves.toBeUndefined();
  },
);
