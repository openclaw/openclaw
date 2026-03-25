import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCompletedTestFileLines,
  parseMemoryTraceSummaryLines,
  parseMemoryValueKb,
} from "../../scripts/test-parallel-memory.mjs";
import {
  appendCapturedOutput,
  hasFatalTestRunOutput,
  resolveTestRunExitCode,
} from "../../scripts/test-parallel-utils.mjs";

describe("scripts/test-parallel fatal output guard", () => {
  it("fails a zero exit when V8 reports an out-of-memory fatal", () => {
    const output = [
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
      "node::OOMErrorHandler(char const*, v8::OOMDetails const&)",
      "[test-parallel] done unit-fast code=0 elapsed=210.9s",
    ].join("\n");

    expect(hasFatalTestRunOutput(output)).toBe(true);
    expect(resolveTestRunExitCode({ code: 0, signal: null, output })).toBe(1);
  });

  it("keeps a clean zero exit green", () => {
    expect(
      resolveTestRunExitCode({
        code: 0,
        signal: null,
        output: "Test Files  3 passed (3)",
      }),
    ).toBe(0);
  });

  it("preserves explicit non-zero exits", () => {
    expect(resolveTestRunExitCode({ code: 2, signal: null, output: "" })).toBe(2);
  });

  it("fails even when the fatal line scrolls out of the retained tail", () => {
    const fatalLine = "FATAL ERROR: Ineffective mark-compacts near heap limit";
    const output = appendCapturedOutput(fatalLine, "x".repeat(250_000), 200_000);

    expect(hasFatalTestRunOutput(output)).toBe(false);
    expect(resolveTestRunExitCode({ code: 0, signal: null, output, fatalSeen: true })).toBe(1);
  });

  it("keeps only the tail of captured output", () => {
    const output = appendCapturedOutput("", "abc", 5);
    expect(appendCapturedOutput(output, "defg", 5)).toBe("cdefg");
  });
});

describe("scripts/test-parallel memory trace parsing", () => {
  it("extracts completed test file lines from colored Vitest output", () => {
    const output = [
      "\u001B[32m✓\u001B[39m src/config/doc-baseline.test.ts \u001B[2m(\u001B[22m\u001B[2m8 tests\u001B[22m\u001B[2m)\u001B[22m\u001B[33m 46424\u001B[2mms\u001B[22m\u001B[39m",
      " \u001B[32m✓\u001B[39m src/infra/restart.test.ts (5 tests) 4.2s",
    ].join("\n");

    expect(parseCompletedTestFileLines(output)).toEqual([
      {
        file: "src/config/doc-baseline.test.ts",
        durationMs: 46_424,
      },
      {
        file: "src/infra/restart.test.ts",
        durationMs: 4_200,
      },
    ]);
  });

  it("ignores non-file summary lines", () => {
    expect(
      parseCompletedTestFileLines(
        [
          " Test Files  2 passed (2)",
          "      Tests  30 passed (30)",
          "[test-parallel] done unit code=0 elapsed=68.8s",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("parses memory trace summary lines and hotspot deltas", () => {
    const summaries = parseMemoryTraceSummaryLines(
      [
        "2026-03-20T04:32:18.7721466Z [test-parallel][mem] summary unit-fast files=360 peak=13.22GiB totalDelta=6.69GiB peakAt=poll top=src/config/schema.help.quality.test.ts:1.06GiB, src/infra/update-runner.test.ts:+463.6MiB",
      ].join("\n"),
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      lane: "unit-fast",
      files: 360,
      peakRssKb: parseMemoryValueKb("13.22GiB"),
      totalDeltaKb: parseMemoryValueKb("6.69GiB"),
      peakAt: "poll",
      top: [
        {
          file: "src/config/schema.help.quality.test.ts",
          deltaKb: parseMemoryValueKb("1.06GiB"),
        },
        {
          file: "src/infra/update-runner.test.ts",
          deltaKb: parseMemoryValueKb("+463.6MiB"),
        },
      ],
    });
  });
});

describe("scripts/test-parallel lane planning", () => {
  it("keeps serial profile on split unit lanes instead of one giant unit worker", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync("node", ["scripts/test-parallel.mjs", "--plan"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_TEST_PROFILE: "serial",
      },
      encoding: "utf8",
    });

    expect(output).toContain("unit-fast");
    expect(output).not.toContain("unit filters=all maxWorkers=1");
  });

  it("recycles default local unit-fast runs into bounded batches", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync("node", ["scripts/test-parallel.mjs", "--plan"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: "",
        OPENCLAW_TEST_UNIT_FAST_LANES: "1",
        OPENCLAW_TEST_UNIT_FAST_BATCH_TARGET_MS: "1",
      },
      encoding: "utf8",
    });

    expect(output).toContain("unit-fast-batch-");
    expect(output).not.toContain("unit-fast filters=all maxWorkers=");
  });

  it("keeps legacy base-pinned targeted reruns on dedicated forks lanes", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync(
      "node",
      [
        "scripts/test-parallel.mjs",
        "--plan",
        "--files",
        "src/auto-reply/reply/followup-runner.test.ts",
      ],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      },
    );

    expect(output).toContain("base-pinned-followup-runner");
    expect(output).not.toContain("base-followup-runner");
  });

  it("reports capability-derived output for mid-memory local macOS hosts", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync(
      "node",
      ["scripts/test-parallel.mjs", "--plan", "--surface", "unit", "--surface", "extensions"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "",
          GITHUB_ACTIONS: "",
          RUNNER_OS: "macOS",
          OPENCLAW_TEST_HOST_CPU_COUNT: "10",
          OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
          OPENCLAW_TEST_LOAD_AWARE: "0",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("runtime=local-darwin mode=local intent=normal memoryBand=mid");
    expect(output).toContain("unit-fast filters=all maxWorkers=4");
    expect(output).toContain("extensions filters=all maxWorkers=3");
  });

  it("explains targeted file ownership and execution policy", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync(
      "node",
      ["scripts/test-parallel.mjs", "--explain", "src/auto-reply/reply/followup-runner.test.ts"],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      },
    );

    expect(output).toContain("surface=base");
    expect(output).toContain("reasons=base-surface,base-pinned-manifest");
    expect(output).toContain("pool=forks");
  });

  it("passes through vitest --mode values that are not wrapper runtime overrides", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync(
      "node",
      [
        "scripts/test-parallel.mjs",
        "--plan",
        "--mode",
        "development",
        "src/infra/outbound/deliver.test.ts",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "",
          GITHUB_ACTIONS: "",
          RUNNER_OS: "Linux",
          OPENCLAW_TEST_HOST_CPU_COUNT: "16",
          OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("mode=local intent=normal memoryBand=high");
    expect(output).toContain("unit-deliver-isolated filters=1");
  });

  it("rejects removed machine-name profiles", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--profile", "macmini"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      }),
    ).toThrowError(/Unsupported test profile "macmini"/u);
  });

  it("rejects unknown explicit surface names", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--surface", "channel"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      }),
    ).toThrowError(/Unsupported --surface value\(s\): channel/u);
  });

  it("rejects wrapper --files values that look like options", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--files", "--config"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      }),
    ).toThrowError(/Invalid --files value/u);
  });
});
