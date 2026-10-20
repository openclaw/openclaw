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
import { createUsageTranscriptEntry } from "./session-cost-usage-fixtures.test-support.js";
import {
  LEGACY_USAGE_COST_PARTITION_SCOPE,
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
} from "./session-cost-usage-partitions.js";

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
