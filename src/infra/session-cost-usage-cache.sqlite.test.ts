import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  deleteSessionCostUsageRollupsExcept,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";

const tempDirs: string[] = [];

function countRegisteredAgentDatabases(): number {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as {
    count: number;
  };
  return row.count;
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("session cost usage SQLite cache", () => {
  it("reads only requested rollups, including an empty selection", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-selection-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      for (const rollupId of ["selected.jsonl", "unrelated.jsonl"]) {
        await writeSessionCostUsageRollup({
          agentId,
          rollupId,
          previousValueJson: null,
          valueJson: JSON.stringify({ session: rollupId }),
          updatedAt: 1,
        });
      }
      expect(readSessionCostUsageRollupRows(agentId, undefined, ["selected.jsonl"])).toEqual([
        { key: "selected.jsonl", updatedAt: 1, valueJson: '{"session":"selected.jsonl"}' },
      ]);
      expect(readSessionCostUsageRollupRows(agentId, undefined, [])).toEqual([]);
      expect(readSessionCostUsageRollupRows(agentId)).toHaveLength(2);
    });
  });

  it("removes a persisted refresh lock owned by a Linux zombie", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-zombie-lock-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const zombiePid = 4242;
      const database = openOpenClawAgentDatabase({ agentId });
      database.db
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run(
          "session-cost-usage",
          "refresh-lock",
          JSON.stringify({ pid: zombiePid, startedAt: 1, ownerNonce: "zombie-owner" }),
          1,
        );
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
        expect(String(filePath)).toBe(`/proc/${zombiePid}/status`);
        return `Name:\tworker\nState:\tZ (zombie)\nPid:\t${zombiePid}\nThreads:\t1\n`;
      });

      expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(false);
      expect(
        database.db
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
          .get("session-cost-usage", "refresh-lock"),
      ).toBeUndefined();
    });
  });

  it("returns empty values without creating a missing agent database", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-missing-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "worker-1" });

      expect(readSessionCostUsageRollupRows("worker-1", databasePath)).toEqual([]);
      expect(await isSessionCostUsageRefreshRunning("worker-1", databasePath)).toBe(false);
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    });
  });

  it("does not register readonly cache reads while writes still register", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-registry-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const database = openOpenClawAgentDatabase({ agentId });
      const databasePath = database.path;
      closeOpenClawAgentDatabasesForTest();

      const stateDatabase = openOpenClawStateDatabase();
      stateDatabase.db.prepare("DELETE FROM agent_databases").run();
      expect(countRegisteredAgentDatabases()).toBe(0);

      expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
      expect(await isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
      expect(countRegisteredAgentDatabases()).toBe(0);

      expect(
        await writeSessionCostUsageRollup({
          agentId,
          databasePath,
          rollupId: "session.jsonl",
          previousValueJson: null,
          valueJson: "{}",
          updatedAt: 1,
        }),
      ).toBe(true);
      expect(countRegisteredAgentDatabases()).toBe(1);
    });
  });

  it.each([
    { label: "changed totals", refreshedValue: '{"totalTokens":2}' },
    { label: "unchanged totals at a newer revision", refreshedValue: '{"totalTokens":1}' },
  ])(
    "preserves a refreshed usage rollup with $label during pruning",
    async ({ refreshedValue }) => {
      const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-prune-race-");

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "worker-1";
        const rollupId = "session.jsonl";
        const staleValue = '{"totalTokens":1}';

        expect(
          await writeSessionCostUsageRollup({
            agentId,
            rollupId,
            previousValueJson: null,
            valueJson: staleValue,
            updatedAt: 1,
          }),
        ).toBe(true);
        const rows = readSessionCostUsageRollupRows(agentId);

        const refreshed = writeSessionCostUsageRollup({
          agentId,
          rollupId,
          previousValueJson: staleValue,
          valueJson: refreshedValue,
          updatedAt: 2,
        });
        await deleteSessionCostUsageRollupsExcept({ agentId, liveKeys: new Set(), rows });
        expect(await refreshed).toBe(true);

        expect(readSessionCostUsageRollupRows(agentId)).toEqual([
          { key: rollupId, updatedAt: 2, valueJson: refreshedValue },
        ]);
      });
    },
  );

  it("bounds stale-rollup deletion work while preserving each snapshot comparison", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-prune-batch-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const scope = "session-cost-usage-rollup-v2";
      const insert = db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      );
      for (let index = 0; index < 97; index += 1) {
        insert.run(
          scope,
          index === 10 ? "stale-10\0雪" : `stale-${index}`,
          JSON.stringify({ totalTokens: index }),
          index + 1,
        );
      }
      insert.run(scope, "live\0雪", '{ "totalTokens": 100 }', 100);
      insert.run("other", "stale-0", '{"totalTokens":0}', 1);
      const rows = readSessionCostUsageRollupRows(agentId);
      db.prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?").run(
        '{"totalTokens":18}',
        scope,
        "stale-17",
      );
      db.prepare("UPDATE cache_entries SET updated_at = ? WHERE scope = ? AND key = ?").run(
        51,
        scope,
        "stale-49",
      );
      const before = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
      const executions = trackSqliteStatementExecutions(db, ["delete"], (sql) =>
        /^delete from "cache_entries"/i.test(sql) ? "delete" : null,
      );

      await deleteSessionCostUsageRollupsExcept({ agentId, liveKeys: new Set(["live\0雪"]), rows });

      expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(
        before.filter(
          (row) =>
            row.scope !== scope || ["live\0雪", "stale-17", "stale-49"].includes(String(row.key)),
        ),
      );
      expect(executions.counts.delete).toBeGreaterThan(0);
      expect(executions.counts.delete).toBeLessThan(12);
      executions.restore();
    });
  });

  it("rolls back all stale and legacy cleanup when a later deletion fails", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-prune-rollback-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const insert = db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      );
      for (let index = 0; index < 97; index += 1) {
        insert.run(
          "session-cost-usage-rollup-v2",
          `stale-${String(index).padStart(3, "0")}`,
          "{}",
          index,
        );
      }
      insert.run("session-cost-usage", "cache", "{}", 1);
      insert.run("session-cost-usage-rollup-v1", "retired", "{}", 1);
      insert.run("session-cost-usage", "refresh-lock", "{}", 1);
      const rows = readSessionCostUsageRollupRows(agentId);
      const before = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
      db.exec(`CREATE TEMP TRIGGER refuse_late_rollup_prune BEFORE DELETE ON cache_entries
        WHEN OLD.scope = 'session-cost-usage-rollup-v2' AND OLD.key = 'stale-080'
        BEGIN SELECT RAISE(ABORT, 'late rollup prune refused'); END;`);
      await expect(
        deleteSessionCostUsageRollupsExcept({ agentId, liveKeys: new Set(), rows }),
      ).rejects.toThrow("late rollup prune refused");
      expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(before);
      db.exec("DROP TRIGGER refuse_late_rollup_prune");

      await deleteSessionCostUsageRollupsExcept({ agentId, liveKeys: new Set(), rows });

      expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(
        before.filter((row) => row.key === "refresh-lock"),
      );
    });
  });

  it("reads only v2 rollups and prunes retired usage cache rows by scope", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-retired-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      expect(
        await writeSessionCostUsageRollup({
          agentId,
          rollupId: "current.jsonl",
          previousValueJson: null,
          valueJson: '{"version":2}',
          updatedAt: 2,
        }),
      ).toBe(true);
      const database = openOpenClawAgentDatabase({ agentId });
      const insert = database.db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      );
      insert.run("session-cost-usage-rollup-v1", "retired.jsonl", '{"version":1}', 1);
      insert.run("session-cost-usage", "cache", "{}", 1);
      insert.run("session-cost-usage", "refresh-lock", "{}", 1);
      insert.run("other", "keep", "{}", 1);

      const rows = readSessionCostUsageRollupRows(agentId);
      expect(rows).toEqual([{ key: "current.jsonl", updatedAt: 2, valueJson: '{"version":2}' }]);

      await deleteSessionCostUsageRollupsExcept({
        agentId,
        liveKeys: new Set(["current.jsonl"]),
        rows,
      });

      expect(
        database.db.prepare("SELECT scope, key FROM cache_entries ORDER BY scope, key").all(),
      ).toEqual([
        { key: "keep", scope: "other" },
        { key: "refresh-lock", scope: "session-cost-usage" },
        { key: "current.jsonl", scope: "session-cost-usage-rollup-v2" },
      ]);
    });
  });
});
