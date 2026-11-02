import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "./openclaw-agent-db-lease.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "./openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import * as agentDb from "./openclaw-agent-db.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "./openclaw-agent-db.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await agentDb.closeOpenClawAgentDatabasesAsync();
    agentDb.closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanup();
  });
});

it.each(["writable", "readonly", "async"] as const)(
  "refuses orphan rows and recovers %s admission after external repair",
  async (admission) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-recovery-") };
    const options = { agentId: "worker-1", env };
    const databasePath = agentDb.resolveOpenClawAgentSqlitePath(options);
    createCurrentOpenClawAgentDatabaseFixtures(
      path.join(env.OPENCLAW_STATE_DIR, "template.sqlite"),
      [{ path: databasePath, agentId: options.agentId }],
    );

    const { DatabaseSync } = requireNodeSqlite();
    {
      using corrupted = new DatabaseSync(databasePath);
      corrupted.exec(`PRAGMA foreign_keys = OFF;
        INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
          VALUES ('orphan-window', 'missing-node', 1, 1);`);
      expect(
        ["quick_check", "integrity_check", "foreign_key_check"].map((check) =>
          corrupted.prepare(`PRAGMA ${check}`).get(),
        ),
      ).toEqual([
        { quick_check: "ok" },
        { integrity_check: "ok" },
        { table: "session_windows", rowid: 1, parent: "session_nodes", fkid: 1 },
      ]);
    }

    invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(databasePath);
    expect(() => agentDb.openOpenClawAgentDatabase(options)).toThrow(
      /foreign_key_check failed.*session_windows row 1 references session_nodes \(foreign key 1\)/iu,
    );
    if (admission === "readonly") {
      const failure = new Error("foreign_key_check failed before external repair");
      failure.name = "SqliteIntegrityError";
      recordOpenClawAgentDatabaseOpenFailure(databasePath, failure);
      using changed = new DatabaseSync(databasePath);
      changed.prepare("UPDATE session_windows SET updated_at = 2").run();
    }
    const open = async () => {
      if (admission === "readonly") {
        const result = openOpenClawAgentDatabaseReadOnly(options);
        expect(result.found).toBe(true);
        if (result.found) {
          result.database.close();
        }
      } else if (admission === "async") {
        await agentDb.withOpenClawAgentDatabaseAsync(options, () => undefined);
      } else {
        agentDb.openOpenClawAgentDatabase(options);
      }
    };
    await expect(open()).rejects.toThrow("foreign_key_check failed");
    {
      using repaired = new DatabaseSync(databasePath);
      repaired.prepare("DELETE FROM session_windows WHERE session_id = ?").run("orphan-window");
      expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    await expect(open()).resolves.toBeUndefined();
  },
);
