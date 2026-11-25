import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSqliteQueryPlanEvidence,
  type SqliteQueryPlanEvidence,
} from "../../scripts/lib/sqlite-query-plan-evidence.js";
import { parseSqliteStateBenchmarkCli } from "../../scripts/lib/sqlite-state-benchmark-cli.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runBench(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-sqlite-state.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("scripts/bench-sqlite-state", () => {
  it("rejects short flag output values before seeding benchmark databases", () => {
    expect(() => parseSqliteStateBenchmarkCli(["--output", "-h"])).toThrow(
      "--output requires a value",
    );
  });

  it("reports production-shaped SQLite scenarios in the existing smoke benchmark", () => {
    const outputDir = tempDirs.make("openclaw-sqlite-bench-test-");
    const outputPath = path.join(outputDir, "report.json");
    const result = runBench(["--profile", "smoke", "--output", outputPath]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("SQLITE_PERF_TRANSCRIPT_ROWS=256");
    const report = JSON.parse(readFileSync(outputPath, "utf8")) as {
      schemaVersion: number;
      queries: Array<{
        id: string;
        p50Ms: number;
        p95Ms: number;
        plan: SqliteQueryPlanEvidence;
        rows: number;
        runs: number;
      }>;
    };
    expect(report.schemaVersion).toBe(2);
    const expectedRows = new Map([
      ["cron.store.load", 13],
      ["task-runs.cron.list", 1_000],
      ["task-runs.cron-source.list", 250],
      ["delivery.pending.load", 696],
      ["ingress.pending.first-page", 100],
      ["ingress.pending.seek-page", 100],
      ["ingress.pending.id-page", 100],
      ["ingress.pending.id-seek-page", 100],
      ["plugin-state.namespace.live", 675],
      ["agent-cache.plugin-model-catalog.list", 64],
      ["transcript.tail.metadata", 256],
      ["transcript.tail.payload", 256],
    ]);
    expect(report.queries.map((query) => query.id)).toEqual([...expectedRows.keys()]);
    for (const query of report.queries) {
      expect(query.rows).toBe(expectedRows.get(query.id));
      expect(query.runs).toBe(20);
      expect(Number.isFinite(query.p50Ms)).toBe(true);
      expect(Number.isFinite(query.p95Ms)).toBe(true);
      expect(query.plan.raw.length).toBeGreaterThan(0);
      expect(query.plan.fullTableScans).toEqual([]);
      if (!query.id.startsWith("task-runs.")) {
        expect(query.plan.tempSorts).toEqual([]);
      }
    }
  });

  it("normalizes modern plan forms without inventing table scans", () => {
    const raw = [
      "SEARCH events USING AUTOMATIC PARTIAL COVERING INDEX (status=?)",
      "SCAN json_each VIRTUAL TABLE INDEX 1:",
      "SCAN 2-ROW VALUES CLAUSE",
      "SCAN task_runs",
    ];
    expect(collectSqliteQueryPlanEvidence([...raw])).toEqual({
      fullTableScans: ["SCAN task_runs"],
      indexes: ["AUTOMATIC PARTIAL COVERING INDEX"],
      raw,
      tempSorts: [],
    });
  });
});
