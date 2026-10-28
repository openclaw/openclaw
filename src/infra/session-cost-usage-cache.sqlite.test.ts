import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { migrateSessionCostUsageRollupStorage } from "./session-cost-usage-cache-migration.js";
import {
  acquireUsageLock,
  createUsageCacheWrite,
  createUsagePartitionWrites,
} from "./session-cost-usage-cache.fixtures.test-support.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  writeSessionCostUsageRollupsInDatabase,
  type SessionCostUsageDeferredMetadata,
} from "./session-cost-usage-cache.kernel.js";
import { isSessionCostUsageRefreshRunning } from "./session-cost-usage-cache.sqlite.js";
import {
  readSessionCostUsageRollupRows,
  pruneUsageCostRollupsForTest,
  readSessionCostUsageRollupEntry,
} from "./session-cost-usage-cache.test-support.js";
import * as fixtures from "./session-cost-usage-fixtures.test-support.js";
import * as partitions from "./session-cost-usage-partitions.js";
import { projectSessionCostSummaries } from "./session-cost-usage-projection.js";
import { decodeUsageCostRollup, encodeUsageCostRollup } from "./session-cost-usage-rollup-codec.js";
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

function sessionsOperation(sessionFile: string, pricingFingerprint: string) {
  return {
    kind: "sessions" as const,
    sessions: [{ sessionFile }],
    pricingFingerprint,
    dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
  };
}

async function cacheSession(
  agentId: string,
  sessionFile: string,
  record = JSON.stringify(fixtures.createUsageTranscriptEntry(7)) + "\n",
) {
  const options = { config: {}, agentId, sessionFiles: [sessionFile] };
  await fs.promises.writeFile(sessionFile, record);
  await refreshCostUsageCacheForAgent(options);
  const row = expectDefined(readSessionCostUsageRollupRows(agentId)[0], "Expected checkpoint");
  const entry = expectDefined(
    readSessionCostUsageRollupEntry(row, agentId),
    "Expected checkpoint body",
  );
  return { options, record, row, entry };
}

function cacheRows(db: ReturnType<typeof openOpenClawAgentDatabase>["db"]) {
  return db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
}

function writeRollup(
  agentId: string,
  valueJson: Uint8Array,
  updatedAt: number,
  rollupId = "session.jsonl",
  blob: Uint8Array | null = null,
) {
  return runOpenClawAgentWriteTransaction(
    ({ db }) =>
      writeSessionCostUsageRollupsInDatabase(db, [{ rollupId, valueJson, updatedAt, blob }]),
    { agentId },
    { operationLabel: "session-cost-usage.rollup.write" },
  );
}

function countRegisteredAgentDatabases(): number {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as { count: number };
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
    const encoded = partitions.partitionUsageCostRollup(
      fixtures.createUsageRollupEntry(rollup, {
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
      }),
    );
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
      Object.values(
        partitions.decodeUsageCostPartition(partition.valueJson, partition.blob)!.buckets,
      ),
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

  it("rolls back checkpoint and partition updates together", async () => {
    const stateDir = tempDirs.make("openclaw-usage-partitions-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "usage-partitions";
      const { db } = openOpenClawAgentDatabase({ agentId });
      await using owner = await acquireUsageLock(agentId);
      const write = (updatedAt: number) =>
        owner.writeRollup([
          {
            ...createUsageCacheWrite("session.jsonl", { checkpoint: updatedAt }, updatedAt),
            partitions: createUsagePartitionWrites(
              ["2026-09-01"],
              { totalTokens: updatedAt },
              updatedAt,
            ),
          },
        ]);
      expect(await write(1)).toBe(true);
      const rows = () => cacheRows(db);
      const before = rows();
      db.exec(`CREATE TRIGGER refuse_usage_partition BEFORE UPDATE ON cache_entries
        WHEN NEW.scope = '${partitions.USAGE_COST_PARTITION_SCOPE}'
        BEGIN SELECT RAISE(ABORT, 'partition refused'); END;`);
      await expect(write(2)).rejects.toThrow("partition refused");
      expect(rows()).toEqual(before);
      db.exec("DROP TRIGGER refuse_usage_partition");
      expect(await write(2)).toBe(true);
      expect(rows()).toEqual(
        before.map((row) =>
          Object.assign({}, row, {
            updated_at: 2,
            value_json:
              row.scope === partitions.USAGE_COST_PARTITION_SCOPE
                ? '{"totalTokens":2}'
                : '{"checkpoint":2}',
            blob: row.scope === partitions.USAGE_COST_PARTITION_SCOPE ? new Uint8Array([2]) : null,
          }),
        ),
      );
    });
  });

  it("migrates valid old reports once while preserving newer cache rows and unrelated scopes", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-migrate-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "usage-migration";
      const { db } = openOpenClawAgentDatabase({ agentId });
      const entry = fixtures.createUsageRollupEntry(createSessionUsageRollupData(), {
        version: 6,
        pricingFingerprint: "synthetic",
        checkpoint: fixtures.createUsageCheckpoint(7, 10, 2),
        scannedAt: 12,
        parsedRecords: 1,
        countedRecords: 0,
      });
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
      const migrate = () =>
        runOpenClawAgentWriteTransaction(
          ({ db: current }) =>
            migrateSessionCostUsageRollupStorage(requireNativeSqliteDatabase(current)),
          { agentId },
        );
      const readRows = () =>
        db
          .prepare(
            "SELECT * FROM cache_entries WHERE scope IN ('session-cost-usage-rollup-v2', 'session-cost-usage-rollup-v3', 'other') ORDER BY scope, key",
          )
          .all();
      migrate();
      const rows = readRows();
      expect(rows.map((row) => [row.scope, row.key])).toEqual([
        ["other", "valid\0雪"],
        ["session-cost-usage-rollup-v3", "newer"],
        ["session-cost-usage-rollup-v3", "valid\0雪"],
      ]);
      expect(rows[0]?.value_json).toBe("unchanged");
      expect(rows[1]).toMatchObject({ value_json: newer.valueJson, updated_at: 999 });
      const migrated = rows[2]!;
      expect(migrated.updated_at).toBe(123);
      // Version-6 reports move intact but predate the current pricing rules, so readers rebuild them.
      expect(migrated.value_json).toBe(encodeUsageCostRollup(entry).valueJson);
      expect(
        decodeUsageCostRollup(
          String(migrated.value_json),
          "synthetic",
          migrated.blob as Uint8Array,
        ),
      ).toBeUndefined();
      migrate();
      expect(readRows()).toEqual(rows);
    });
  });

  it("replaces a large prior value without reading it back", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-cas-payload-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId }).db);
      const previousValueJson = JSON.stringify({ history: "雪".repeat(400_000) });
      expect(writeRollup(agentId, utf8Json(previousValueJson), 1, "large.jsonl")).toBe(true);
      const executions = trackSqliteStatementExecutions(db, ["cache"], (sql) =>
        /\bcache_entries\b/i.test(sql) ? "cache" : null,
      );
      try {
        expect(writeRollup(agentId, utf8Json('{"totalTokens":2}'), 2, "large.jsonl")).toBe(true);
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

  it.each([undefined, "{invalid"])(
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
          writeRollup(agentId, utf8Json(valueJson), 2, rollupId, new Uint8Array([3, 4, 5])),
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

  it("persists a usage refresh when a sibling adopts shared admission during schema refresh", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-readmission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const database = await withOpenClawAgentDatabaseWrite({ agentId }, (opened) => opened);
      const write = async (valueJson: string, updatedAt: number) => {
        await using owner = await acquireUsageLock(agentId, database.path);
        return await owner.writeRollup([
          createUsageCacheWrite("session.jsonl", valueJson, updatedAt),
        ]);
      };
      expect(await write('{"totalTokens":1}', 1)).toBe(true);
      database.db.exec("CREATE TABLE usage_readmission_fixture(value TEXT)");
      const capture = validationCache.captureOpenClawAgentDatabaseAdmissionPublication;
      vi.spyOn(
        validationCache,
        "captureOpenClawAgentDatabaseAdmissionPublication",
      ).mockImplementation((target) => {
        const publish = capture(target);
        // A retained reader can adopt the shared receipt while worker admission is pending.
        validationCache.getOpenClawAgentDatabaseValidation(database);
        return publish;
      });
      expect(await write('{"totalTokens":2}', 2)).toBe(true);
      expect(readSessionCostUsageRollupRows(agentId, database.path)).toMatchObject([
        { key: "session.jsonl", valueJson: '{"totalTokens":2}', updatedAt: 2 },
      ]);
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

      expect(writeRollup(agentId, utf8Json("{}"), 1)).toBe(true);
      expect(countRegisteredAgentDatabases()).toBe(1);
    });
  });

  it("prunes stale rollups off-thread while preserving each snapshot comparison", async () => {
    const stateDir = tempDirs.make("openclaw-usage-cache-prune-batch-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const agentId = "worker-1";
      const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId }).db);
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
      insert.run("session-cost-usage-rollup-v1", "retired.jsonl", '{"version":1}', 1);
      insert.run("session-cost-usage", "cache", "{}", 1);
      insert.run("session-cost-usage", "refresh-lock", "{}", 1);
      const rows = readSessionCostUsageRollupRows(agentId);
      expect(rows).toHaveLength(98);
      expect(rows.every((row) => row.key === "live\0雪" || row.key.startsWith("stale-"))).toBe(
        true,
      );
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
      const before = cacheRows(db);
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

      expect(cacheRows(db)).toEqual(
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
        await using owner = await acquireUsageLock(agentId);
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
        const before = cacheRows(db);
        db.exec(`CREATE TRIGGER refuse_late_rollup_prune BEFORE DELETE ON cache_entries
        WHEN OLD.scope = 'session-cost-usage-rollup-v3' AND OLD.key = 'stale-080'
        BEGIN SELECT RAISE(ABORT, 'late rollup prune refused'); END;`);
        await expect(owner.pruneRows(rows)).rejects.toThrow("late rollup prune refused");
        expect(cacheRows(db)).toEqual(before);
        db.exec("DROP TRIGGER refuse_late_rollup_prune");

        await owner.pruneRows(rows);

        expect(cacheRows(db)).toEqual(
          before.filter((row) => row.scope !== "session-cost-usage-rollup-v3"),
        );
      });
    },
  );
});

it.each(["stored", "decoded", "corrupt-length"] as const)(
  "refreshes genuinely stale %s budget-deferred checkpoints",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "usage-deferred-freshness";
      const sessionFile = state.path("deferred-freshness.jsonl");
      const { options, record, row, entry } = await cacheSession(agentId, sessionFile);
      const encoded = fixtures.encodeOversizedUsageRollup(
        entry,
        mode === "stored" ? "stored body" : mode === "decoded" ? "compressed body" : mode,
        "synthetic-",
      );
      {
        await using lock = await acquireUsageLock(agentId);
        await lock.writeRollup([
          createUsageCacheWrite(row.key, encoded.valueJson, row.updatedAt, encoded.blob),
        ]);
      }
      const prepared = prepareUsageCostWorker(options);
      for (const stale of [false, true]) {
        if (stale) {
          await fs.promises.appendFile(sessionFile, record);
        }
        const result = await runUsageCostWorker(
          prepared,
          sessionsOperation(sessionFile, entry.pricingFingerprint),
        );
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
      const { options, record, row, entry } = await cacheSession(agentId, sessionFile);
      if (mode !== "valid") {
        writeRollup(
          agentId,
          Buffer.from(row.valueJson),
          row.updatedAt,
          row.key,
          mode === "truncated" ? encodeUsageCostRollup(entry).blob.subarray(1) : null,
        );
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
        const prepared = prepareUsageCostWorker(options);
        const operation = sessionsOperation(sessionFile, entry.pricingFingerprint);
        expect(await runUsageCostWorker(prepared, operation)).toMatchObject({
          staleSessionFiles: [sessionFile],
        });
        // No rebuildRows: the refresh owner must detect actual body corruption itself.
        await refreshCostUsageCacheForAgent(options);
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
      const agentId = "usage-missing-partition";
      const sessionFile = state.path("usage-missing-partition.jsonl");
      const record = (day: number) =>
        JSON.stringify(
          fixtures.createUsageTranscriptEntry(10, {
            timestamp: new Date(Date.UTC(2026, 8, day)).toISOString(),
            model: "fixture",
            provider: "test",
            cost: 1,
          }),
        ) + "\n";
      const { options, row, entry } = await cacheSession(
        agentId,
        sessionFile,
        record(18) + record(19) + record(31),
      );
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          if (mode === "identity-length") {
            const partition = db
              .prepare(
                "SELECT key, value_json FROM cache_entries WHERE scope = ? ORDER BY key LIMIT 1",
              )
              .get(partitions.USAGE_COST_PARTITION_SCOPE);
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
              partitions.USAGE_COST_PARTITION_SCOPE,
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
              ? [partitions.USAGE_COST_PARTITION_SCOPE]
              : [
                  partitions.USAGE_COST_PARTITION_SCOPE,
                  " ".repeat(64 * 1024 + 1),
                  partitions.USAGE_COST_PARTITION_SCOPE,
                ]),
          );
        },
        { agentId },
      );
      const prepared = prepareUsageCostWorker(options);
      const operation = sessionsOperation(sessionFile, entry.pricingFingerprint);
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
