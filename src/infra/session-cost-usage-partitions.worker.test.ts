import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent as refreshUsage } from "./session-cost-usage-aggregation.js";
import {
  acquireUsageLock,
  createUsageCacheWrite as rollup,
  createUsagePartitionWrites as partitions,
} from "./session-cost-usage-cache.fixtures.test-support.js";
import { readSessionCostUsageRollupRows as readRows } from "./session-cost-usage-cache.test-support.js";
import {
  createUsageTranscriptEntry,
  overviewRows,
} from "./session-cost-usage-fixtures.test-support.js";
import {
  LEGACY_USAGE_COST_PARTITION_SCOPE,
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
} from "./session-cost-usage-partitions.js";
import { USAGE_COST_QUARTER_SCOPE } from "./session-cost-usage-quarters.js";
import { USAGE_COST_ROLLUP_SCOPE } from "./session-cost-usage-rollup-codec.js";
import { withUsageWorkerPreload } from "./session-cost-usage-worker-io.test-support.js";
import { loadSessionUsageOverviewFromCache } from "./session-cost-usage.js";

it("rebuilds retired usage partitions even when the transcript is unchanged", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-retired-partitions";
    const sessionFile = path.join(state.sessionsDir(agentId), "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    const transcript = `${JSON.stringify({
      ...createUsageTranscriptEntry(10, { cost: 1 }),
      id: "retained",
      parentId: null,
    })}\n`;
    await fs.writeFile(sessionFile, transcript);
    const refresh = () => refreshUsage({ config: {}, agentId, sessionFiles: [sessionFile] });
    await refresh();
    const row = readRows(agentId)[0]!;
    const envelope: unknown = JSON.parse(row.valueJson);
    assert(isRecord(envelope) && isRecord(envelope.projection), "Expected a partition checkpoint");
    envelope.projection.version = 2;
    const { db } = openOpenClawAgentDatabase({ agentId });
    const countPartitions = db.prepare(
      "SELECT count(*) AS count FROM cache_entries WHERE scope = ?",
    );
    db.prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?").run(
      JSON.stringify(envelope),
      "session-cost-usage-rollup-v3",
      row.key,
    );
    db.prepare("UPDATE cache_entries SET scope = ?, key = ? WHERE scope = ?").run(
      LEGACY_USAGE_COST_PARTITION_SCOPE,
      [row.key, "2026-09-01"].join("\0"),
      USAGE_COST_PARTITION_SCOPE,
    );

    await refresh();
    expect(countPartitions.get(USAGE_COST_PARTITION_SCOPE)).toEqual({ count: 1 });
    expect(JSON.parse(readRows(agentId)[0]!.valueJson)).toMatchObject({
      projection: { version: 3 },
    });
    expect(await fs.readFile(sessionFile, "utf8")).toBe(transcript);
  });
});

it("retires selected months across batches atomically while retaining other partitions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const agentId = "usage-partitions";
    const rollupId = "session.jsonl";
    const removedDates = Array.from({ length: 101 }, (_, index) =>
      new Date(Date.UTC(2010, index, 1)).toISOString().slice(0, 10),
    );
    const { db } = openOpenClawAgentDatabase({ agentId });
    const rows = () => db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
    await using owner = await acquireUsageLock(agentId);
    expect(
      await owner.writeRollup([
        {
          ...rollup(rollupId, { phase: "before" }),
          partitions: partitions([...removedDates, "2026-09-01"], { retained: true }, 1),
        },
        {
          ...rollup("other-session.jsonl", {}),
          partitions: partitions([removedDates[0]!, removedDates[100]!], { unrelated: true }, 2),
        },
      ]),
    ).toBe(true);
    db.prepare(
      "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run("other", usageCostPartitionKey(rollupId, removedDates[0]!), "unchanged", 1);
    const before = rows();
    const update = [{ ...rollup(rollupId, { phase: "after" }, 2), removedDates }];
    // The last month fails after the first deletion batch has already run.
    db.exec(`CREATE TRIGGER refuse_late_month_delete BEFORE DELETE ON cache_entries
      WHEN OLD.scope = '${USAGE_COST_PARTITION_SCOPE}'
        AND OLD.key = '"session.jsonl":${removedDates[100]}'
      BEGIN SELECT RAISE(ABORT, 'late month delete refused'); END;`);
    await expect(owner.writeRollup(update)).rejects.toThrow("late month delete refused");
    expect(rows()).toEqual(before);
    db.exec("DROP TRIGGER refuse_late_month_delete");

    expect(await owner.writeRollup(update)).toBe(true);
    const removedKeys = new Set(removedDates.map((date) => usageCostPartitionKey(rollupId, date)));
    expect(rows()).toEqual(
      before
        .filter(
          (row) => row.scope !== USAGE_COST_PARTITION_SCOPE || !removedKeys.has(String(row.key)),
        )
        .map((row) =>
          row.scope === "session-cost-usage-rollup-v3" && row.key === rollupId
            ? Object.assign({}, row, { value_json: '{"phase":"after"}', updated_at: 2 })
            : row,
        ),
    );
  });
});

it("batches mixed usage replacement and append writes while retaining unrelated months", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const log = path.join(state.root, "usage-write-counts.txt");
    const preload = path.join(state.root, "usage-write-counts.cjs");
    await fs.writeFile(log, "");
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const { DatabaseSync } = require("node:sqlite");
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    const kind = /^delete from "cache_entries"/i.test(sql) ? "delete"
      : /^insert into "cache_entries"/i.test(sql) ? "insert" : null;
    if (kind) for (const method of ["run", "all", "get"]) {
      const original = statement[method];
      statement[method] = function(...args) {
        fs.appendFileSync(${JSON.stringify(log)}, kind + "\\n");
        return Reflect.apply(original, this, args);
      };
    }
    return statement;
  };
}
`,
    );
    await withUsageWorkerPreload(state.stateDir, preload, async () => {
      const agentId = "usage-batched-publication";
      const { db } = openOpenClawAgentDatabase({ agentId });
      await using owner = await acquireUsageLock(agentId);
      const ids = Array.from({ length: 50 }, (_, index) => `session-${index}`);
      await owner.writeRollup(
        [...ids, "unrelated"].map((id) =>
          Object.assign(rollup(id, { totalTokens: 7 }, 1, new Uint8Array([1])), {
            partitions: partitions(["2026-01-01", "2026-02-01"], { tokens: 3 }, 2),
          }),
        ),
      );
      await fs.writeFile(log, "");
      expect(
        await owner.writeRollup(
          ids.map((id, index) => ({
            ...rollup(id, { totalTokens: 20 + index }, 2, new Uint8Array([17])),
            partitions: partitions(
              [index < 25 ? "2026-03-01" : "2026-02-01"],
              { tokens: 10 + index },
              34,
            ),
            ...(index < 25 ? { replacePartitions: true } : { removedDates: ["2026-01-01"] }),
          })),
        ),
      ).toBe(true);
      const executions = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect({
        deletes: executions.filter((kind) => kind === "delete").length,
        inserts: executions.filter((kind) => kind === "insert").length,
      }).toEqual({ deletes: 2, inserts: 1 });

      const rows = db
        .prepare(
          `SELECT scope, key, value_json, hex(blob) AS blob, updated_at
           FROM cache_entries WHERE scope IN (?, ?)`,
        )
        .all(USAGE_COST_ROLLUP_SCOPE, USAGE_COST_PARTITION_SCOPE);
      const row = (scope: string, key: string, value: object, blob: string, updated_at = 2) => ({
        scope,
        key,
        value_json: JSON.stringify(value),
        blob,
        updated_at,
      });
      const expected = ids.flatMap((id, index) => [
        row(USAGE_COST_ROLLUP_SCOPE, id, { totalTokens: 20 + index }, "11"),
        row(
          USAGE_COST_PARTITION_SCOPE,
          usageCostPartitionKey(id, index < 25 ? "2026-03-01" : "2026-02-01"),
          { tokens: 10 + index },
          "22",
        ),
      ]);
      expected.push(
        row(USAGE_COST_ROLLUP_SCOPE, "unrelated", { totalTokens: 7 }, "01", 1),
        ...["2026-01-01", "2026-02-01"].map((date) =>
          row(
            USAGE_COST_PARTITION_SCOPE,
            usageCostPartitionKey("unrelated", date),
            { tokens: 3 },
            "02",
            1,
          ),
        ),
      );
      expect(rows).toHaveLength(103);
      expect(rows).toEqual(expect.arrayContaining(expected));
    });
  });
});

it("pairs quarter rows with their partitions through refresh, rollback writes, and pruning", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-quarter-lifecycle";
    const sessionsDir = state.sessionsDir(agentId);
    await fs.mkdir(sessionsDir, { recursive: true });
    const entry = (timestamp: string, tokens: number) =>
      JSON.stringify(createUsageTranscriptEntry(tokens, { timestamp, cost: tokens }));
    const first = path.join(sessionsDir, "first.jsonl");
    const second = path.join(sessionsDir, "second.jsonl");
    await fs.writeFile(
      first,
      `${entry("2026-08-31T23:50:00Z", 2)}\n${entry("2026-09-01T00:05:00Z", 3)}\n`,
    );
    await fs.writeFile(second, `${entry("2026-09-02T10:00:00Z", 5)}\n`);
    const { db } = openOpenClawAgentDatabase({ agentId });
    const count = (sql: string) =>
      (
        db.prepare(sql).get(USAGE_COST_PARTITION_SCOPE, USAGE_COST_QUARTER_SCOPE) as {
          count: number;
        }
      ).count;
    const coverage = () => ({
      partitions: count("SELECT count(*) AS count FROM cache_entries WHERE scope = ? OR ? IS NULL"),
      quarters: count(
        "SELECT count(*) AS count FROM cache_entries WHERE ? IS NOT NULL AND scope = ?",
      ),
      paired: count(`SELECT count(*) AS count FROM cache_entries p JOIN cache_entries q
        ON q.key = p.key AND q.updated_at = p.updated_at AND q.scope = ?2 WHERE p.scope = ?1`),
    });
    const overview = async () =>
      overviewRows(
        await loadSessionUsageOverviewFromCache({
          config: {},
          agentId,
          families: [[{ sessionFile: first }], [{ sessionFile: second }]],
          startMs: Date.UTC(2026, 7, 31),
          endMs: Date.UTC(2026, 8, 3) - 1,
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        }),
      );
    await refreshUsage({ config: {}, agentId, sessionFiles: [first, second] });
    // The partition producer commits each month's quarter row with it.
    expect(coverage()).toEqual({ partitions: 3, quarters: 3, paired: 3 });
    expect(await overview()).toMatchObject({
      rows: [{ totalTokens: 5 }, { totalTokens: 5 }],
      summarizing: 0,
    });

    // A build without quarter rows rewrites a partition; the stale quarter row no longer pairs.
    db.prepare(
      "UPDATE cache_entries SET updated_at = updated_at + 1 WHERE scope = ? AND key = ?",
    ).run(USAGE_COST_PARTITION_SCOPE, usageCostPartitionKey(first, "2026-09-01"));
    // The read asks the refresh owner to derive the row from the partition, waits, and is exact.
    expect(await overview()).toMatchObject({
      rows: [{ totalTokens: 5 }, { totalTokens: 5 }],
      computing: [false, false],
      summarizing: 0,
      cacheStatus: { status: "fresh" },
    });
    expect(coverage()).toEqual({ partitions: 3, quarters: 3, paired: 3 });
    const derived = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
    await refreshUsage({ config: {}, agentId, sessionFiles: [first] });
    expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(derived);

    // Removed months and pruned sessions delete their quarter rows with the partitions.
    await fs.writeFile(first, `${entry("2026-09-01T00:05:00Z", 3)}\n`);
    await refreshUsage({ config: {}, agentId, sessionFiles: [first] });
    expect(coverage()).toEqual({ partitions: 2, quarters: 2, paired: 2 });
    await fs.unlink(second);
    await refreshUsage({ config: {}, agentId });
    expect(coverage()).toEqual({ partitions: 1, quarters: 1, paired: 1 });
  });
});
