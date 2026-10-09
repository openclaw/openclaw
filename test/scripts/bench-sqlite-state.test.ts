// Bench SQLite State tests cover benchmark CLI argument safety.
import { describe, expect, it } from "vitest";
import { collectSqliteQueryPlanEvidence } from "../../scripts/lib/sqlite-query-plan-evidence.js";
import { parseSqliteStateBenchmarkCli } from "../../scripts/lib/sqlite-state-benchmark-cli.js";

describe("scripts/bench-sqlite-state", () => {
  it("rejects short flag output values before seeding benchmark databases", () => {
    expect(() => parseSqliteStateBenchmarkCli(["--output", "-h"])).toThrow(
      "--output requires a value",
    );
  });

  it("rejects duplicate single-value controls before seeding benchmark databases", () => {
    expect(() =>
      parseSqliteStateBenchmarkCli(["--profile", "smoke", "--profile", "large"]),
    ).toThrow("--profile was provided more than once");
    expect(parseSqliteStateBenchmarkCli(["--help", "--profile", "huge"])).toEqual({
      help: true,
    });
  });

  it("normalizes modern plan forms without inventing table scans", () => {
    expect(
      collectSqliteQueryPlanEvidence([
        "SEARCH events USING AUTOMATIC PARTIAL COVERING INDEX (status=?)",
        "SCAN json_each VIRTUAL TABLE INDEX 1:",
        "SCAN 2-ROW VALUES CLAUSE",
        "SCAN task_runs",
      ]),
    ).toEqual({
      fullTableScans: ["SCAN task_runs"],
      indexes: ["AUTOMATIC PARTIAL COVERING INDEX"],
      raw: [
        "SEARCH events USING AUTOMATIC PARTIAL COVERING INDEX (status=?)",
        "SCAN json_each VIRTUAL TABLE INDEX 1:",
        "SCAN 2-ROW VALUES CLAUSE",
        "SCAN task_runs",
      ],
      tempSorts: [],
    });
  });
});
