// Snapshot stress benchmark tests cover CLI parsing and report helpers.
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  percentile,
  summarizeIterationMetrics,
} from "../../scripts/bench-snapshot-sqlite.ts";

describe("bench-snapshot-sqlite script", () => {
  it("parses default global options", () => {
    expect(parseArgs([])).toEqual({
      agentId: null,
      output: null,
      profile: "default",
      repository: null,
      stateDir: null,
      target: { kind: "global" },
    });
  });

  it("parses agent target and paths", () => {
    expect(
      parseArgs([
        "--profile",
        "smoke",
        "--agent",
        "ops-team",
        "--state-dir",
        "/tmp/state",
        "--repository",
        "/tmp/repo",
        "--output",
        "/tmp/report.json",
      ]),
    ).toEqual({
      agentId: "ops-team",
      output: "/tmp/report.json",
      profile: "smoke",
      repository: "/tmp/repo",
      stateDir: "/tmp/state",
      target: { agentId: "ops-team", kind: "agent" },
    });
  });

  it("rejects malformed profile and target options", () => {
    expect(() => parseArgs(["--profile", "tiny"])).toThrow(
      '--profile must be one of smoke, default, large; got "tiny"',
    );
    expect(() => parseArgs(["--target", "agent"])).toThrow("--target must be global");
    expect(() => parseArgs(["--agent", "--output"])).toThrow("--agent requires a value");
  });

  it("computes percentile samples", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5, 1, 10, 2], 50)).toBe(2);
    expect(percentile([5, 1, 10, 2], 95)).toBe(10);
  });

  it("summarizes iteration metrics", () => {
    expect(
      summarizeIterationMetrics([
        { restoreMs: 3, snapshotBytes: 100, snapshotMs: 9 },
        { restoreMs: 1, snapshotBytes: 200, snapshotMs: 4 },
        { restoreMs: 2, snapshotBytes: 150, snapshotMs: 6 },
      ]),
    ).toEqual({
      max: 200,
      min: 100,
      restoreP50: 2,
      restoreP95: 3,
      snapshotP50: 6,
      snapshotP95: 9,
      total: 0,
    });
  });
});
