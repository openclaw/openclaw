import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import * as validationCache from "../state/openclaw-agent-db-validation-cache.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import {
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { migrateSessionCostUsageRollupStorage } from "./session-cost-usage-cache-migration.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  writeSessionCostUsageRollupInDatabase,
  type SessionCostUsageDeferredMetadata,
} from "./session-cost-usage-cache.kernel.js";
import {
  isSessionCostUsageRefreshRunning,
  prepareSessionCostUsageRefreshLock,
} from "./session-cost-usage-cache.sqlite.js";
import {
  readSessionCostUsageRollupRows,
  pruneUsageCostRollupsForTest,
  readSessionCostUsageRollupEntry,
} from "./session-cost-usage-cache.test-support.js";
import {
  partitionUsageCostRollup,
  decodeUsageCostPartition,
  USAGE_COST_PARTITION_SCOPE,
} from "./session-cost-usage-partitions.js";
import { projectSessionCostSummaries } from "./session-cost-usage-projection.js";
import {
  decodeUsageCostRollup,
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_VERSION,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import { loadSessionCostSummariesFromCache } from "./session-cost-usage.js";

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
  it("keeps a sparse year below 25 KB without discarding quarter-hour accounting", () => {
    const rollup = createSessionUsageRollupData();
    for (let index = 0; index < 500; index++) {
      appendSessionUsageRollupContribution(rollup, {
        timestamp:
          Date.UTC(2025, 0, 1) +
          Math.floor((index * 365) / 500) * 86_400_000 +
          (index % 2) * 900_000,
        role: "assistant",
        model: "fixture",
        provider: "test",
        toolNames: [],
        toolResultCounts: { total: 0, errors: 0 },
        usageTotals: { ...rollup.untimestamped.totals, totalTokens: 10, totalCost: 1 },
      });
    }
    const encoded = partitionUsageCostRollup({
      version: USAGE_COST_ROLLUP_VERSION,
      pricingFingerprint: "fixture",
      scannedAt: 1,
      parsedRecords: 500,
      countedRecords: 500,
      checkpoint: {
        kind: "sqlite",
        maxSeq: 500,
        eventCount: 500,
        size: 500,
        mtimeMs: 1,
        anchorHash: "fixture",
      },
      rollup,
    });
    const bytes =
      Buffer.byteLength(encoded.valueJson) +
      encoded.blob.byteLength +
      encoded.partitions.reduce(
        (sum, partition) =>
          sum + Buffer.byteLength(partition.valueJson) + partition.blob.byteLength,
        0,
      );
    expect(bytes).toBeLessThan(25_000);
    const buckets = encoded.partitions.flatMap((partition) =>
      Object.values(decodeUsageCostPartition(partition.valueJson, partition.blob)!.buckets),
    );
    expect(buckets.reduce((sum, bucket) => sum + bucket.totals.totalTokens, 0)).toBe(5_000);
    expect(
      buckets.map((bucket) => bucket.timestampMs).toSorted((left, right) => left - right),
    ).toEqual(
      Object.values(rollup.buckets)
        .map((bucket) => bucket.timestampMs)
        .toSorted((left, right) => left - right),
    );
  });

  it("commits monthly quarter-hour partitions with their checkpoint and retires deleted months", async () => {
    const stateDir = tempDirs.make("openclaw-usage-partitions-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "usage-partitions";
      const sessionFile = "session.jsonl";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const owner = prepareSessionCostUsageRefreshLock(agentId);
      expect(await owner.acquire()).toBe(true);
      const readPartitions = (startDate = "", endDate = "\uffff") =>
        db
          .prepare(
            "SELECT key, value_json, blob FROM cache_entries WHERE scope = ? AND key >= ? AND key <= ? ORDER BY key",
          )
          .all(
            USAGE_COST_PARTITION_SCOPE,
            `${sessionFile}\0${startDate}`,
            `${sessionFile}\0${endDate}`,
          )
          .map((row) => {
            if (typeof row.value_json !== "string" || !(row.blob instanceof Uint8Array)) {
              throw new Error("Expected a persisted usage partition");
            }
            return {
              date: String(row.key).slice(sessionFile.length + 1),
              valueJson: row.value_json,
              blob: row.blob,
            };
          });
      try {
        const rollup = createSessionUsageRollupData();
        for (const timestamp of [
          Date.UTC(2026, 8, 18),
          Date.UTC(2026, 8, 18, 0, 1),
          Date.UTC(2026, 8, 19),
        ]) {
          appendSessionUsageRollupContribution(rollup, {
            timestamp,
            role: "assistant",
            model: "test",
            provider: "test",
            toolNames: [],
            toolResultCounts: { total: 0, errors: 0 },
            usageTotals: { ...rollup.untimestamped.totals, totalTokens: 10, totalCost: 1 },
          });
        }
        const entry = {
          version: USAGE_COST_ROLLUP_VERSION,
          pricingFingerprint: "first",
          scannedAt: 1,
          parsedRecords: 3,
          countedRecords: 3,
          checkpoint: {
            kind: "jsonl" as const,
            parsedOffset: 3,
            observedSize: 3,
            observedMtimeMs: 1,
            device: 1,
            inode: 1,
            anchorHash: "anchor",
          },
          rollup,
        };
        const first = partitionUsageCostRollup(entry);
        expect(
          await owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(first.valueJson),
            blob: first.blob,
            partitions: first.partitions,
            updatedAt: 1,
          }),
        ).toBe(true);
        const days = readPartitions();
        expect(days.map((day) => day.date)).toEqual(["2026-09-01"]);
        const selected = readPartitions("2026-09-01", "2026-09-01");
        expect(selected).toHaveLength(1);
        const day = decodeUsageCostPartition(selected[0]!.valueJson, selected[0]!.blob)!;
        expect(Object.values(day.buckets)).toMatchObject([
          { totals: { totalTokens: 20, totalCost: 2 } },
          { totals: { totalTokens: 10, totalCost: 1 } },
        ]);
        expect(
          Object.keys(decodeUsageCostRollup(first.valueJson, "first", first.blob)!.rollup.buckets),
        ).toEqual([]);

        const before = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
        db.exec(`CREATE TRIGGER refuse_usage_partition BEFORE UPDATE ON cache_entries
        WHEN NEW.scope = '${USAGE_COST_PARTITION_SCOPE}'
        BEGIN SELECT RAISE(ABORT, 'partition refused'); END;`);
        await expect(
          owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(first.valueJson),
            blob: first.blob,
            partitions: first.partitions,
            updatedAt: 2,
          }),
        ).rejects.toThrow("partition refused");
        expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(before);
        db.exec("DROP TRIGGER refuse_usage_partition");

        const rewritten = partitionUsageCostRollup({
          ...entry,
          pricingFingerprint: "changed",
          rollup: createSessionUsageRollupData(),
        });
        expect(
          await owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(rewritten.valueJson),
            blob: rewritten.blob,
            partitions: [],
            removedDates: ["2026-09-01"],
            updatedAt: 3,
          }),
        ).toBe(true);
        expect(readPartitions()).toEqual([]);
        expect(decodeUsageCostRollup(rewritten.valueJson, "first", rewritten.blob)).toBeUndefined();
        expect(
          await owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(first.valueJson),
            blob: first.blob,
            partitions: first.partitions,
            updatedAt: 4,
          }),
        ).toBe(true);
        // A downgraded owner ignores projection rows and replaces only the checkpoint.
        const legacy = encodeUsageCostRollup({ ...entry, version: 6 });
        expect(
          await owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(legacy.valueJson),
            blob: legacy.blob,
            updatedAt: 5,
          }),
        ).toBe(true);
        expect(
          await owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(rewritten.valueJson),
            blob: rewritten.blob,
            partitions: [],
            replacePartitions: true,
            updatedAt: 6,
          }),
        ).toBe(true);
        expect(readPartitions()).toEqual([]);
        expect(
          await owner.writeRollup({
            rollupId: sessionFile,
            valueJson: utf8Json(first.valueJson),
            blob: first.blob,
            partitions: first.partitions,
            updatedAt: 7,
          }),
        ).toBe(true);
        await owner.pruneRows(readSessionCostUsageRollupRows(agentId));
        expect(readSessionCostUsageRollupRows(agentId)).toEqual([]);
        expect(readPartitions()).toEqual([]);
      } finally {
        await owner.release();
      }
    });
  });

  it("migrates valid old reports once while preserving newer cache rows and unrelated scopes", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-migrate-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "usage-migration";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const entry = {
        version: 6,
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

  it("replaces a large prior value without reading it back", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-cas-payload-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const previousValueJson = JSON.stringify({ history: "雪".repeat(400_000) });
      expect(
        writeRollup(agentId, {
          rollupId: "large.jsonl",
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
        { key: "large.jsonl", updatedAt: 2, valueJson: '{"totalTokens":2}', bodyBytes: 0 },
      ]);
    });
  });

  it.each([undefined, null, "{invalid", '{"total":1}'])(
    "upserts UTF-8 reports over prior value %s while preserving other scopes",
    async (current) => {
      const stateDir = tempDirs.make("openclaw-usage-cache-upsert-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "worker-1";
        const { db } = openOpenClawAgentDatabase({ agentId });
        const rollupId = "session\0雪";
        const valueJson = '{"label":"€🦞", "total":2}';
        const insert = db.prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
        );
        if (current !== undefined) {
          insert.run("session-cost-usage-rollup-v3", rollupId, current, 1);
        }
        insert.run("other", rollupId, "unchanged", 1);
        expect(
          writeRollup(agentId, {
            rollupId,
            valueJson: utf8Json(valueJson),
            blob: new Uint8Array([3, 4, 5]),
            updatedAt: 2,
          }),
        ).toBe(true);
        expect(readSessionCostUsageRollupRows(agentId)).toEqual([
          { key: rollupId, valueJson, updatedAt: 2, bodyBytes: 3 },
        ]);
        expect(
          db.prepare("SELECT value_json FROM cache_entries WHERE scope = 'other'").get(),
        ).toEqual({ value_json: "unchanged" });
      });
    },
  );

  it("serializes refreshes in-process without persisting lock or status writes", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-exclusion-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const database = openOpenClawAgentDatabase({ agentId });
      const owner = prepareSessionCostUsageRefreshLock(agentId, database.path);
      const contender = prepareSessionCostUsageRefreshLock(agentId, database.path);
      try {
        expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(false);
        expect(await owner.acquire()).toBe(true);
        expect(await contender.acquire()).toBe(false);
        expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(true);
        expect(database.db.prepare("SELECT * FROM cache_entries").all()).toEqual([]);
        await owner.release();
        expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(false);
        expect(await contender.acquire()).toBe(true);
      } finally {
        await owner.release();
        await contender.release();
      }
      expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(false);
      expect(database.db.prepare("SELECT * FROM cache_entries").all()).toEqual([]);
    });
  });

  it("persists a usage refresh when a sibling adopts shared admission during schema refresh", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-readmission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const database = await withOpenClawAgentDatabaseWrite({ agentId }, (opened) => opened);
      const write = async (valueJson: string, updatedAt: number) => {
        const owner = prepareSessionCostUsageRefreshLock(agentId, database.path);
        try {
          expect(await owner.acquire()).toBe(true);
          return await owner.writeRollup({
            rollupId: "session.jsonl",
            valueJson: utf8Json(valueJson),
            blob: null,
            updatedAt,
          });
        } finally {
          await owner.release();
        }
      };
      expect(await write('{"totalTokens":1}', 1)).toBe(true);
      database.db.exec("CREATE TABLE usage_readmission_fixture(value TEXT)");
      const capture = validationCache.captureOpenClawAgentDatabaseAdmissionPublication;
      const publication = vi
        .spyOn(validationCache, "captureOpenClawAgentDatabaseAdmissionPublication")
        .mockImplementation((target) => {
          const publish = capture(target);
          // A retained reader can adopt the shared receipt while worker admission is pending.
          validationCache.getOpenClawAgentDatabaseValidation(database);
          return publish;
        });
      try {
        expect(await write('{"totalTokens":2}', 2)).toBe(true);
        expect(readSessionCostUsageRollupRows(agentId, database.path)).toMatchObject([
          { key: "session.jsonl", valueJson: '{"totalTokens":2}', updatedAt: 2 },
        ]);
      } finally {
        publication.mockRestore();
      }
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
      await closeOpenClawAgentDatabasesAsync();

      unregisterOpenClawAgentDatabase({ agentId, path: databasePath });
      expect(countRegisteredAgentDatabases()).toBe(0);

      expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
      expect(await isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
      expect(countRegisteredAgentDatabases()).toBe(0);

      expect(
        writeRollup(agentId, {
          rollupId: "session.jsonl",
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
            valueJson: utf8Json(staleValue),
            updatedAt: 1,
          }),
        ).toBe(true);
        const rows = readSessionCostUsageRollupRows(agentId);

        const refreshed = writeRollup(agentId, {
          rollupId,
          valueJson: utf8Json(refreshedValue),
          updatedAt: 2,
        });
        await pruneUsageCostRollupsForTest({ agentId, liveKeys: new Set(), rows });
        expect(refreshed).toBe(true);

        expect(readSessionCostUsageRollupRows(agentId)).toEqual([
          { key: rollupId, updatedAt: 2, valueJson: refreshedValue, bodyBytes: 0 },
        ]);
      });
    },
  );

  it("prunes stale rollups off-thread while preserving each snapshot comparison", async () => {
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

      await pruneUsageCostRollupsForTest({
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
      expect(executions.counts.delete).toBe(0);
      executions.restore();
    });
  });

  it.each(["string", "utf8"] as const)(
    "rolls back all %s stale cleanup when a later deletion fails",
    async (format) => {
      const stateDir = tempDirs.make("openclaw-usage-cache-prune-rollback-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentId = "worker-1";
        const { db } = openOpenClawAgentDatabase({ agentId });
        const owner = prepareSessionCostUsageRefreshLock(agentId);
        expect(await owner.acquire()).toBe(true);
        // Admit the writer before installing the fault-injection trigger.
        await owner.pruneRows([]);
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
        const rows = readSessionCostUsageRollupRows(agentId).map((row) => ({
          key: row.key,
          updatedAt: row.updatedAt,
          valueJson: encodeJson(row.valueJson, format),
        }));
        const before = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
        db.exec(`CREATE TRIGGER refuse_late_rollup_prune BEFORE DELETE ON cache_entries
        WHEN OLD.scope = 'session-cost-usage-rollup-v3' AND OLD.key = 'stale-080'
        BEGIN SELECT RAISE(ABORT, 'late rollup prune refused'); END;`);
        await expect(owner.pruneRows(rows)).rejects.toThrow("late rollup prune refused");
        expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(before);
        db.exec("DROP TRIGGER refuse_late_rollup_prune");

        await owner.pruneRows(rows);

        expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(
          before.filter((row) => row.scope !== "session-cost-usage-rollup-v3"),
        );
        await owner.release();
      });
    },
  );

  it("reads and prunes only current rollups without touching retired scopes", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-retired-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      expect(
        writeRollup(agentId, {
          rollupId: "current.jsonl",
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
      expect(rows).toEqual([
        { key: "current.jsonl", updatedAt: 2, valueJson: '{"version":2}', bodyBytes: 0 },
      ]);

      await pruneUsageCostRollupsForTest({
        agentId,
        liveKeys: new Set(["current.jsonl"]),
        rows,
      });

      expect(
        database.db.prepare("SELECT scope, key FROM cache_entries ORDER BY scope, key").all(),
      ).toEqual([
        { key: "keep", scope: "other" },
        { key: "cache", scope: "session-cost-usage" },
        { key: "refresh-lock", scope: "session-cost-usage" },
        { key: "retired.jsonl", scope: "session-cost-usage-rollup-v1" },
        { key: "current.jsonl", scope: "session-cost-usage-rollup-v3" },
      ]);
    });
  });
});

it.each(["stored", "decoded", "corrupt-length"] as const)(
  "refreshes genuinely stale %s budget-deferred checkpoints",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = {};
      const agentId = "usage-deferred-freshness";
      const sessionFile = state.path("deferred-freshness.jsonl");
      const record =
        JSON.stringify({
          type: "message",
          timestamp: "2026-09-18T00:00:00Z",
          message: { role: "assistant", usage: { input: 7, output: 0, totalTokens: 7 } },
        }) + "\n";
      await fs.promises.writeFile(sessionFile, record);
      await refreshCostUsageCacheForAgent({ config, agentId, sessionFiles: [sessionFile] });
      const row = readSessionCostUsageRollupRows(agentId)[0];
      if (!row) {
        throw new Error("Expected stored checkpoint");
      }
      const entry = readSessionCostUsageRollupEntry(row, agentId);
      if (!entry) {
        throw new Error("Expected valid checkpoint body");
      }
      if (mode !== "corrupt-length") {
        entry.rollup.untimestamped.tools = [
          { name: "synthetic-" + "x".repeat((mode === "stored" ? 2 : 35) * 1024 * 1024), count: 1 },
        ];
      }
      const encoded = encodeUsageCostRollup(entry);
      if (mode === "corrupt-length") {
        const envelope = JSON.parse(encoded.valueJson);
        envelope.body.bytes = 35 * 1024 * 1024;
        encoded.valueJson = JSON.stringify(envelope);
      }
      if (mode === "stored") {
        encoded.blob = Uint8Array.from(Buffer.from(JSON.stringify(entry.rollup)));
        const envelope = JSON.parse(encoded.valueJson);
        envelope.body.encoding = "identity";
        envelope.body.storedBytes = encoded.blob.byteLength;
        encoded.valueJson = JSON.stringify(envelope);
      }
      const lock = prepareSessionCostUsageRefreshLock(agentId);
      try {
        expect(await lock.acquire()).toBe(true);
        expect(
          await lock.writeRollup({
            rollupId: row.key,
            valueJson: new TextEncoder().encode(encoded.valueJson),
            blob: encoded.blob,
            updatedAt: row.updatedAt,
          }),
        ).toBe(true);
      } finally {
        await lock.release();
      }
      const prepared = prepareUsageCostWorker({ config, agentId, sessionFiles: [sessionFile] });
      for (const stale of [false, true]) {
        if (stale) {
          await fs.promises.appendFile(sessionFile, record);
        }
        const result = await runUsageCostWorker(prepared, {
          kind: "sessions",
          sessions: [{ sessionFile }],
          pricingFingerprint: entry.pricingFingerprint,
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        });
        expect(result).toMatchObject({
          kind: "sessions",
          summaries: [null],
          staleSessionFiles: stale || mode === "corrupt-length" ? [sessionFile] : [],
          invalidRows: [],
          cacheStatus: { pendingFiles: 1, staleFiles: stale || mode === "corrupt-length" ? 1 : 0 },
        });
      }
    });
  },
);

it.each(["valid", "missing", "truncated"] as const)(
  "preserves freshness or repairs %s bodies after header exhaustion",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "usage-header-allowance";
      const sessionFile = state.path("header-allowance.jsonl");
      const record =
        JSON.stringify({
          type: "message",
          timestamp: "2026-09-18T00:00:00Z",
          message: { role: "assistant", usage: { input: 7, totalTokens: 7 } },
        }) + "\n";
      await fs.promises.writeFile(sessionFile, record);
      await refreshCostUsageCacheForAgent({ config: {}, agentId, sessionFiles: [sessionFile] });
      const row = readSessionCostUsageRollupRows(agentId)[0];
      const entry = row && readSessionCostUsageRollupEntry(row, agentId);
      if (!entry || !row) {
        throw new Error("Expected stored checkpoint");
      }
      if (mode !== "valid") {
        writeRollup(agentId, {
          rollupId: row.key,
          valueJson: Buffer.from(row.valueJson),
          updatedAt: row.updatedAt,
          blob: mode === "truncated" ? encodeUsageCostRollup(entry).blob.subarray(1) : undefined,
        });
      }
      const budget = {
        remainingBytes: 128,
        deferredPaths: new Set<string>(),
        deferredMetadata: new Map<string, SessionCostUsageDeferredMetadata>(),
        metadataLimit: 1,
        pricingFingerprint: entry.pricingFingerprint,
      };
      const rows = readSessionCostUsageRollupRowsInDatabase(
        openOpenClawAgentDatabase({ agentId }).db,
        [row.key],
        { includeBody: true, budget },
      );
      expect(rows).toEqual([]);
      expect(budget.remainingBytes).toBe(128);
      expect(budget.deferredMetadata.size).toBe(mode === "valid" ? 1 : 0);
      expect(budget.deferredPaths.has(row.key)).toBe(mode === "valid");
      if (mode === "valid") {
        expect(budget.deferredMetadata.get(row.key)?.checkpoint).not.toHaveProperty("anchorHash");
      }
      for (const stale of mode === "valid" ? [false, true] : [false]) {
        if (stale) {
          await fs.promises.appendFile(sessionFile, record);
        }
        const stat = await fs.promises.stat(sessionFile);
        const result = await projectSessionCostSummaries({
          readRow: () => undefined,
          readBody: () => null,
          onInvalidBody: () => {},
          remainingRows: [],
          deferredPaths: budget.deferredPaths,
          deferredMetadata: budget.deferredMetadata,
          sessions: [{ sessionFile }],
          files: [
            {
              filePath: row.key,
              sourcePath: sessionFile,
              kind: "jsonl",
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              device: stat.dev,
              inode: stat.ino,
            },
          ],
          pricingFingerprint: entry.pricingFingerprint,
        });
        expect(result).toMatchObject({
          summaries: [null],
          staleSessionFiles: stale || mode !== "valid" ? [sessionFile] : [],
          cacheStatus: { pendingFiles: 1, staleFiles: stale || mode !== "valid" ? 1 : 0 },
        });
      }
      if (mode !== "valid") {
        const prepared = prepareUsageCostWorker({
          config: {},
          agentId,
          sessionFiles: [sessionFile],
        });
        const operation = {
          kind: "sessions" as const,
          sessions: [{ sessionFile }],
          pricingFingerprint: entry.pricingFingerprint,
          dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
        };
        expect(await runUsageCostWorker(prepared, operation)).toMatchObject({
          staleSessionFiles: [sessionFile],
        });
        // No rebuildRows: the refresh owner must detect actual body corruption itself.
        await refreshCostUsageCacheForAgent({ config: {}, agentId, sessionFiles: [sessionFile] });
        expect(await runUsageCostWorker(prepared, operation)).toMatchObject({
          staleSessionFiles: [],
          summaries: [{ totalTokens: 7 }],
        });
      }
    });
  },
);

it.each(["missing", "oversized-first", "oversized-last", "identity-length"])(
  "repairs %s monthly partitions and filters within and across months",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = {};
      const agentId = "usage-missing-partition";
      const sessionFile = state.path("usage-missing-partition.jsonl");
      const options = { config, agentId, sessionFiles: [sessionFile] };
      const record = (day: number) =>
        JSON.stringify({
          type: "message",
          timestamp: new Date(Date.UTC(2026, 8, day)).toISOString(),
          message: {
            role: "assistant",
            model: "fixture",
            provider: "test",
            usage: { input: 10, output: 0, totalTokens: 10, cost: { total: 1 } },
          },
        }) + "\n";
      await fs.promises.writeFile(sessionFile, record(18) + record(19) + record(31));
      await refreshCostUsageCacheForAgent(options);
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          if (mode === "identity-length") {
            const partition = db
              .prepare(
                "SELECT key, value_json FROM cache_entries WHERE scope = ? ORDER BY key LIMIT 1",
              )
              .get(USAGE_COST_PARTITION_SCOPE);
            if (
              !partition ||
              typeof partition.key !== "string" ||
              typeof partition.value_json !== "string"
            ) {
              throw new Error("Expected partition header");
            }
            db.prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?").run(
              JSON.stringify({
                ...JSON.parse(partition.value_json),
                encoding: "identity",
                bytes: 35 * 1024 * 1024,
              }),
              USAGE_COST_PARTITION_SCOPE,
              partition.key,
            );
            return;
          }
          db.prepare(
            mode === "missing"
              ? "DELETE FROM cache_entries WHERE (scope, key) IN (SELECT scope, key FROM cache_entries WHERE scope = ? ORDER BY key LIMIT 1)"
              : `UPDATE cache_entries SET value_json = CASE WHEN key = (SELECT key FROM cache_entries WHERE scope = ? ORDER BY key ${mode === "oversized-last" ? "DESC" : "ASC"} LIMIT 1) THEN ? || value_json ELSE value_json END, blob = zeroblob(2097152) WHERE scope = ?`,
          ).run(
            ...(mode === "missing"
              ? [USAGE_COST_PARTITION_SCOPE]
              : [
                  USAGE_COST_PARTITION_SCOPE,
                  " ".repeat(64 * 1024 + 1),
                  USAGE_COST_PARTITION_SCOPE,
                ]),
          );
        },
        { agentId },
      );
      const row = readSessionCostUsageRollupRows(agentId)[0];
      if (!row) {
        throw new Error("Expected stored checkpoint");
      }
      const prepared = prepareUsageCostWorker(options);
      const operation = {
        kind: "sessions" as const,
        sessions: [{ sessionFile }],
        pricingFingerprint: JSON.parse(row.valueJson).pricingFingerprint,
        dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
      };
      expect(
        await runUsageCostWorker(prepared, { ...operation, startMs: Date.UTC(2026, 8, 18) + 1 }),
      ).toMatchObject({ summaries: [{ totalTokens: 20 }], staleSessionFiles: [] });
      const rejected = await runUsageCostWorker(prepared, operation);
      expect(rejected).toMatchObject({
        summaries: [null],
        staleSessionFiles: [sessionFile],
        invalidRows: [row],
        cacheStatus: { staleFiles: 1 },
      });
      await refreshCostUsageCacheForAgent({ ...options, rebuildRows: [row] });
      await fs.promises.appendFile(sessionFile, record(20));
      await refreshCostUsageCacheForAgent(options);
      for (const [startMs, endMs, totalTokens] of [
        [Date.UTC(2026, 8, 19), Date.UTC(2026, 8, 20) - 1, 10],
        [Date.UTC(2026, 8, 20), Date.UTC(2026, 9, 2) - 1, 20],
        [Date.UTC(2026, 8, 18), Date.UTC(2026, 9, 2) - 1, 40],
      ]) {
        expect(
          await loadSessionCostSummariesFromCache({
            ...options,
            sessions: [{ sessionFile }],
            requestRefresh: false,
            startMs,
            endMs,
            dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
          }),
        ).toMatchObject({ summaries: [{ totalTokens }], cacheStatus: { status: "fresh" } });
      }
    });
  },
);
