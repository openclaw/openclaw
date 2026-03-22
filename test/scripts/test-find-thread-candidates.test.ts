import { describe, expect, it } from "vitest";
import {
  getExistingThreadCandidateExclusions,
  parseArgs,
  selectThreadCandidateFiles,
  summarizeThreadBenchmark,
} from "../../scripts/test-find-thread-candidates.mjs";

describe("scripts/test-find-thread-candidates parseArgs", () => {
  it("parses explicit thresholds and positional files", () => {
    expect(
      parseArgs([
        "--limit",
        "4",
        "--min-duration-ms",
        "600",
        "--min-gain-ms",
        "120",
        "--min-gain-pct",
        "15",
        "--json",
        "src/a.test.ts",
      ]),
    ).toEqual({
      config: "vitest.unit.config.ts",
      limit: 4,
      minDurationMs: 600,
      minGainMs: 120,
      minGainPct: 15,
      json: true,
      files: ["src/a.test.ts"],
    });
  });

  it("accepts zero thresholds for explicit deep scans", () => {
    expect(parseArgs(["--min-duration-ms", "0", "--min-gain-ms", "0"])).toMatchObject({
      minDurationMs: 0,
      minGainMs: 0,
    });
  });
});

describe("scripts/test-find-thread-candidates exclusions", () => {
  it("collects already-pinned files across behavior buckets", () => {
    expect(
      getExistingThreadCandidateExclusions({
        base: {
          threadSingleton: [{ file: "src/base-a.test.ts" }],
        },
        unit: {
          isolated: [{ file: "src/a.test.ts" }],
          singletonIsolated: [{ file: "src/b.test.ts" }],
          threadSingleton: [{ file: "src/c.test.ts" }],
          vmForkSingleton: [{ file: "src/d.test.ts" }],
        },
      }),
    ).toEqual(
      new Set([
        "src/base-a.test.ts",
        "src/a.test.ts",
        "src/b.test.ts",
        "src/c.test.ts",
        "src/d.test.ts",
      ]),
    );
  });
});

describe("scripts/test-find-thread-candidates selection", () => {
  it("keeps only known, unpinned files above the duration floor", () => {
    expect(
      selectThreadCandidateFiles({
        files: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts"],
        timings: {
          files: {
            "src/a.test.ts": { durationMs: 1100 },
            "src/b.test.ts": { durationMs: 700 },
            "src/c.test.ts": { durationMs: 300 },
          },
        },
        exclude: new Set(["src/b.test.ts"]),
        limit: 10,
        minDurationMs: 500,
      }),
    ).toEqual(["src/a.test.ts"]);
  });

  it("allows explicit unknown-duration files when requested", () => {
    expect(
      selectThreadCandidateFiles({
        files: ["src/a.test.ts", "src/b.test.ts"],
        timings: {
          files: {
            "src/a.test.ts": { durationMs: 700 },
          },
        },
        exclude: new Set(),
        limit: 10,
        minDurationMs: 500,
        includeUnknownDuration: true,
      }),
    ).toEqual(["src/a.test.ts", "src/b.test.ts"]);
  });
});

describe("scripts/test-find-thread-candidates summarizeThreadBenchmark", () => {
  it("recommends clear thread wins", () => {
    expect(
      summarizeThreadBenchmark({
        file: "src/a.test.ts",
        forks: { exitCode: 0, elapsedMs: 1000, stderr: "", stdout: "" },
        threads: { exitCode: 0, elapsedMs: 780, stderr: "", stdout: "" },
        minGainMs: 100,
        minGainPct: 10,
      }),
    ).toMatchObject({
      file: "src/a.test.ts",
      gainMs: 220,
      recommended: true,
    });
  });

  it("rejects thread failures even when the measured wall time is lower", () => {
    expect(
      summarizeThreadBenchmark({
        file: "src/b.test.ts",
        forks: { exitCode: 0, elapsedMs: 1000, stderr: "", stdout: "" },
        threads: { exitCode: 1, elapsedMs: 400, stderr: "TypeError", stdout: "" },
        minGainMs: 100,
        minGainPct: 10,
      }).recommended,
    ).toBe(false);
  });
});
