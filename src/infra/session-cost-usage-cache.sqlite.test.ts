import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { migrateSessionCostUsageRollupStorage } from "./session-cost-usage-cache-migration.js";
import { writeSessionCostUsageRollupInDatabase } from "./session-cost-usage-cache.kernel.js";
import {
  deleteSessionCostUsageRollupsExcept,
  isSessionCostUsageRefreshRunning,
  prepareSessionCostUsageRefreshLock,
} from "./session-cost-usage-cache.sqlite.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import {
  decodeUsageCostRollup,
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_VERSION,
} from "./session-cost-usage-rollup-codec.js";
import { createSessionUsageRollupData } from "./session-cost-usage-rollup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function utf8Json(value: string) {
  const framed = new TextEncoder().encode(`x${value}y`);
  return framed.subarray(1, framed.byteLength - 1);
}

function encodeJson(value: string, format: "string" | "utf8") {
  return format === "string" ? value : utf8Json(value);
}

function writeRollup(
  agentId: string,
  params: Omit<Parameters<typeof writeSessionCostUsageRollupInDatabase>[1], "blob"> & {
    blob?: Uint8Array;
  },
) {
  return runOpenClawAgentWriteTransaction(
    ({ db }) => writeSessionCostUsageRollupInDatabase(db, { ...params, blob: params.blob ?? null }),
    { agentId },
    { operationLabel: "session-cost-usage.rollup.write" },
  );
}

function countRegisteredAgentDatabases(): number {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as {
    count: number;
  };
  return row.count;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("session cost usage SQLite cache", () => {
  it("migrates valid old reports once while preserving newer cache rows and unrelated scopes", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-migrate-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "usage-migration";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const entry = {
        version: USAGE_COST_ROLLUP_VERSION,
        pricingFingerprint: "synthetic",
        checkpoint: {
          kind: "jsonl" as const,
          parsedOffset: 7,
          observedSize: 7,
          observedMtimeMs: 10,
          device: 1,
          inode: 2,
          anchorHash: "anchor",
        },
        scannedAt: 12,
        parsedRecords: 1,
        countedRecords: 0,
        rollup: createSessionUsageRollupData(),
      };
      entry.rollup.untimestamped.totals.totalTokens = 17;
      const insert = db.prepare(
        "INSERT INTO cache_entries(scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?)",
      );
      for (const [key, json] of [
        ["valid\0雪", JSON.stringify(entry)],
        ["newer", JSON.stringify(entry)],
        ["broken", "{"],
        ["obsolete", JSON.stringify({ ...entry, version: 5 })],
      ] as const) {
        insert.run("session-cost-usage-rollup-v2", key, json, null, 123);
      }
      const newer = encodeUsageCostRollup({ ...entry, scannedAt: 999 });
      insert.run("session-cost-usage-rollup-v3", "newer", newer.valueJson, newer.blob, 999);
      insert.run("other", "valid\0雪", "unchanged", null, 1);
      runOpenClawAgentWriteTransaction(
        ({ db: current }) => migrateSessionCostUsageRollupStorage(current),
        { agentId },
      );
      const rows = db
        .prepare(
          "SELECT * FROM cache_entries WHERE scope IN ('session-cost-usage-rollup-v2', 'session-cost-usage-rollup-v3', 'other') ORDER BY scope, key",
        )
        .all();
      expect(rows.map((row) => [row.scope, row.key])).toEqual([
        ["other", "valid\0雪"],
        ["session-cost-usage-rollup-v3", "newer"],
        ["session-cost-usage-rollup-v3", "valid\0雪"],
      ]);
      expect(rows[0]?.value_json).toBe("unchanged");
      expect(rows[1]).toMatchObject({ value_json: newer.valueJson, updated_at: 999 });
      const migrated = rows[2]!;
      expect(migrated.updated_at).toBe(123);
      expect(
        decodeUsageCostRollup(
          String(migrated.value_json),
          "synthetic",
          migrated.blob as Uint8Array,
        ),
      ).toEqual(entry);
      runOpenClawAgentWriteTransaction(
        ({ db: current }) => migrateSessionCostUsageRollupStorage(current),
        { agentId },
      );
      expect(
        db
          .prepare(
            "SELECT * FROM cache_entries WHERE scope IN ('session-cost-usage-rollup-v2', 'session-cost-usage-rollup-v3', 'other') ORDER BY scope, key",
          )
          .all(),
      ).toEqual(rows);
    });
  });

  it("keeps compare-and-swap text returned to the caller bounded for large values", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-cas-payload-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const previousValueJson = JSON.stringify({ history: "雪".repeat(400_000) });
      expect(
        writeRollup(agentId, {
          rollupId: "large.jsonl",
          previousValueJson: null,
          valueJson: utf8Json(previousValueJson),
          updatedAt: 1,
        }),
      ).toBe(true);
      const executions = trackSqliteStatementExecutions(db, ["cache"], (sql) =>
        /\bcache_entries\b/i.test(sql) ? "cache" : null,
      );
      try {
        expect(
          writeRollup(agentId, {
            rollupId: "large.jsonl",
            previousValueJson: utf8Json(previousValueJson),
            valueJson: utf8Json('{"totalTokens":2}'),
            updatedAt: 2,
          }),
        ).toBe(true);
        expect(executions.counts.cache).toBeGreaterThan(0);
        expect(executions.textBytes.cache).toBeLessThan(1_024);
      } finally {
        executions.restore();
      }
      expect(readSessionCostUsageRollupRows(agentId)).toEqual([
        { key: "large.jsonl", updatedAt: 2, valueJson: '{"totalTokens":2}' },
      ]);
    });
  });

  it("preserves exact text, null recovery, and refusals for UTF-8 compare-and-swap values", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-cas-values-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const scope = "session-cost-usage-rollup-v3";
      const currentJson = '{ "label": "雪🦞é", "total": 1 }';
      const nextJson = '{"label":"€🦞", "total":2}';
      const insert = db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const select = db.prepare(
        "SELECT value_json, typeof(value_json) AS value_type, blob, expires_at, updated_at FROM cache_entries WHERE scope = ? AND key = ?",
      );
      const cases: Array<{
        label: string;
        current: string | null | undefined;
        previous: string | null;
        applied: boolean;
      }> = [
        { label: "insert", current: undefined, previous: null, applied: true },
        { label: "null recovery", current: null, previous: null, applied: true },
        { label: "exact match", current: currentJson, previous: currentJson, applied: true },
        { label: "invalid JSON", current: "{雪", previous: "{雪", applied: true },
        { label: "missing", current: undefined, previous: currentJson, applied: false },
        { label: "null mismatch", current: null, previous: currentJson, applied: false },
        { label: "existing", current: currentJson, previous: null, applied: false },
        { label: "stale", current: nextJson, previous: currentJson, applied: false },
        {
          label: "whitespace mismatch",
          current: currentJson,
          previous: '{"label":"雪🦞é","total":1}',
          applied: false,
        },
        { label: "Unicode mismatch", current: '"é"', previous: '"e\u0301"', applied: false },
        { label: "embedded NUL", current: "{雪\0}", previous: "{雪\0}", applied: true },
      ];
      for (const { label, current, previous, applied } of cases) {
        const rollupId = `${label}\0雪`;
        if (current !== undefined) {
          insert.run(scope, rollupId, current, new Uint8Array([1, 2]), 123, 1);
        }
        insert.run("other", rollupId, currentJson, null, null, 1);
        const before = select.get(scope, rollupId);
        const otherBefore = select.get("other", rollupId);
        expect(
          writeRollup(agentId, {
            rollupId,
            previousValueJson: previous === null ? null : utf8Json(previous),
            valueJson: utf8Json(nextJson),
            blob: new Uint8Array([3, 4, 5]),
            updatedAt: 2,
          }),
          label,
        ).toBe(applied);
        expect(select.get(scope, rollupId), label).toEqual(
          applied
            ? {
                value_json: nextJson,
                value_type: "text",
                blob: new Uint8Array([3, 4, 5]),
                expires_at: null,
                updated_at: 2,
              }
            : before,
        );
        expect(select.get("other", rollupId), label).toEqual(otherBefore);
      }
    });
  });

  it("reclaims a zombie refresh lock on acquisition without writing during status reads", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-zombie-lock-");

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

      const readLock = () =>
        database.db
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
          .get("session-cost-usage", "refresh-lock");
      expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(false);
      expect(readLock()).toEqual({
        value_json: JSON.stringify({ pid: zombiePid, startedAt: 1, ownerNonce: "zombie-owner" }),
      });
      const owner = prepareSessionCostUsageRefreshLock(agentId, database.path);
      try {
        expect(await owner.acquire()).toBe(true);
        expect(readLock()).not.toEqual({
          value_json: JSON.stringify({ pid: zombiePid, startedAt: 1, ownerNonce: "zombie-owner" }),
        });
      } finally {
        await owner.release();
      }
      expect(readLock()).toBeUndefined();
    });
  });

  it("returns empty values without creating a missing agent database", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-missing-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "worker-1" });

      expect(readSessionCostUsageRollupRows("worker-1", databasePath)).toEqual([]);
      expect(await isSessionCostUsageRefreshRunning("worker-1", databasePath)).toBe(false);
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    });
  });

  it("does not register readonly cache reads while writes still register", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-registry-");

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
        writeRollup(agentId, {
          rollupId: "session.jsonl",
          previousValueJson: null,
          valueJson: utf8Json("{}"),
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
      const stateDir = tempDirs.make("openclaw-usage-cache-prune-race-");

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "worker-1";
        const rollupId = "session.jsonl";
        const staleValue = '{"totalTokens":1}';

        expect(
          writeRollup(agentId, {
            rollupId,
            previousValueJson: null,
            valueJson: utf8Json(staleValue),
            updatedAt: 1,
          }),
        ).toBe(true);
        const rows = readSessionCostUsageRollupRows(agentId);

        const refreshed = writeRollup(agentId, {
          rollupId,
          previousValueJson: utf8Json(staleValue),
          valueJson: utf8Json(refreshedValue),
          updatedAt: 2,
        });
        await deleteSessionCostUsageRollupsExcept({ agentId, liveKeys: new Set(), rows });
        expect(refreshed).toBe(true);

        expect(readSessionCostUsageRollupRows(agentId)).toEqual([
          { key: rollupId, updatedAt: 2, valueJson: refreshedValue },
        ]);
      });
    },
  );

  it("bounds stale-rollup deletion work while preserving each snapshot comparison", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-prune-batch-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const scope = "session-cost-usage-rollup-v3";
      const insert = db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      );
      for (let index = 0; index < 97; index += 1) {
        insert.run(
          scope,
          index === 10 ? "stale-10\0雪" : `stale-${index}`,
          JSON.stringify({ label: "雪🦞", totalTokens: index }),
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

      await deleteSessionCostUsageRollupsExcept({
        agentId,
        liveKeys: new Set(["live\0雪"]),
        rows: rows.map((row) => ({
          key: row.key,
          updatedAt: row.updatedAt,
          valueJson: encodeJson(row.valueJson, "utf8"),
        })),
      });

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

  it.each(["string", "utf8"] as const)(
    "rolls back all %s stale and legacy cleanup when a later deletion fails",
    async (format) => {
      const stateDir = tempDirs.make("openclaw-usage-cache-prune-rollback-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "worker-1";
        const { db } = openOpenClawAgentDatabase({ agentId });
        const insert = db.prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        );
        for (let index = 0; index < 97; index += 1) {
          insert.run(
            "session-cost-usage-rollup-v3",
            `stale-${String(index).padStart(3, "0")}`,
            "{}",
            index,
          );
        }
        insert.run("session-cost-usage", "cache", "{}", 1);
        insert.run("session-cost-usage-rollup-v1", "retired", "{}", 1);
        insert.run("session-cost-usage", "refresh-lock", "{}", 1);
        const rows = readSessionCostUsageRollupRows(agentId).map((row) => ({
          key: row.key,
          updatedAt: row.updatedAt,
          valueJson: encodeJson(row.valueJson, format),
        }));
        const before = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
        db.exec(`CREATE TEMP TRIGGER refuse_late_rollup_prune BEFORE DELETE ON cache_entries
        WHEN OLD.scope = 'session-cost-usage-rollup-v3' AND OLD.key = 'stale-080'
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
    },
  );

  it("reads only v3 rollups and prunes retired usage cache rows by scope", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-retired-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      expect(
        writeRollup(agentId, {
          rollupId: "current.jsonl",
          previousValueJson: null,
          valueJson: utf8Json('{"version":2}'),
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
        { key: "current.jsonl", scope: "session-cost-usage-rollup-v3" },
      ]);
    });
  });
});
