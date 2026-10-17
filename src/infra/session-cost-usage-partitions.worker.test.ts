import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import {
  LEGACY_USAGE_COST_PARTITION_SCOPE,
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
} from "./session-cost-usage-partitions.js";

function utf8Json(value: string) {
  return new TextEncoder().encode(value);
}

it("rebuilds retired usage partitions even when the transcript is unchanged", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-retired-partitions";
    const sessionFile = path.join(state.sessionsDir(agentId), "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    const transcript = `${JSON.stringify({
      type: "message",
      id: "retained",
      parentId: null,
      timestamp: "2026-09-18T00:00:00Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "test",
        usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
      },
    })}\n`;
    await fs.writeFile(sessionFile, transcript);
    const config = {};
    const refresh = () =>
      refreshCostUsageCacheForAgent({ config, agentId, sessionFiles: [sessionFile] });
    await refresh();
    const row = readSessionCostUsageRollupRows(agentId)[0]!;
    const envelope: unknown = JSON.parse(row.valueJson);
    if (!isRecord(envelope) || !isRecord(envelope.projection)) {
      throw new Error("Expected a persisted partition checkpoint");
    }
    envelope.projection.version = 2;
    const { db } = openOpenClawAgentDatabase({ agentId });
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
    expect(
      db
        .prepare("SELECT count(*) AS count FROM cache_entries WHERE scope = ?")
        .get(USAGE_COST_PARTITION_SCOPE),
    ).toEqual({ count: 1 });
    expect(JSON.parse(readSessionCostUsageRollupRows(agentId)[0]!.valueJson)).toMatchObject({
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
    const retainedDate = "2026-09-01";
    const { db } = openOpenClawAgentDatabase({ agentId });
    const owner = prepareSessionCostUsageRefreshLock(agentId);
    expect(await owner.acquire()).toBe(true);
    try {
      expect(
        await owner.writeRollup([
          {
            rollupId,
            valueJson: utf8Json('{"phase":"before"}'),
            blob: null,
            updatedAt: 1,
            partitions: [...removedDates, retainedDate].map((date) => ({
              date,
              valueJson: '{"retained":true}',
              blob: new Uint8Array([1]),
            })),
          },
          {
            rollupId: "other-session.jsonl",
            valueJson: utf8Json("{}"),
            blob: null,
            updatedAt: 1,
            partitions: [removedDates[0]!, removedDates[100]!].map((date) => ({
              date,
              valueJson: '{"unrelated":true}',
              blob: new Uint8Array([2]),
            })),
          },
        ]),
      ).toBe(true);
      db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run("other", usageCostPartitionKey(rollupId, removedDates[0]!), "unchanged", 1);
      const before = db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all();
      const update = [
        {
          rollupId,
          valueJson: utf8Json('{"phase":"after"}'),
          blob: null,
          updatedAt: 2,
          removedDates,
        },
      ];
      // The last month fails after the first deletion batch has already run.
      db.exec(`CREATE TRIGGER refuse_late_month_delete BEFORE DELETE ON cache_entries
      WHEN OLD.scope = '${USAGE_COST_PARTITION_SCOPE}'
        AND OLD.key = '"session.jsonl":${removedDates[100]}'
      BEGIN SELECT RAISE(ABORT, 'late month delete refused'); END;`);
      await expect(owner.writeRollup(update)).rejects.toThrow("late month delete refused");
      expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(before);
      db.exec("DROP TRIGGER refuse_late_month_delete");

      expect(await owner.writeRollup(update)).toBe(true);
      const removedKeys = new Set(
        removedDates.map((date) => usageCostPartitionKey(rollupId, date)),
      );
      expect(db.prepare("SELECT * FROM cache_entries ORDER BY scope, key").all()).toEqual(
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
    } finally {
      await owner.release();
    }
  });
});
