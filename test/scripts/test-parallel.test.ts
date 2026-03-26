import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

const clearPlannerShardEnv = (env) => {
  const nextEnv = { ...env };
  delete nextEnv.OPENCLAW_TEST_SHARDS;
  delete nextEnv.OPENCLAW_TEST_SHARD_INDEX;
  delete nextEnv.OPENCLAW_TEST_FORCE_THREADS;
  delete nextEnv.OPENCLAW_TEST_FORCE_FORKS;
  delete nextEnv.OPENCLAW_TEST_DISABLE_THREAD_EXPANSION;
  delete nextEnv.OPENCLAW_TEST_SHOW_POOL_DECISION;
  return nextEnv;
};

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
        ...clearPlannerShardEnv(process.env),
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
        ...clearPlannerShardEnv(process.env),
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
        env: clearPlannerShardEnv(process.env),
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
          ...clearPlannerShardEnv(process.env),
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

    expect(output).toContain("mode=local intent=normal memoryBand=mid");
    expect(output).toContain("unit-fast filters=all maxWorkers=");
    expect(output).toContain("extensions filters=all maxWorkers=");
  });

  it("explains targeted file ownership and execution policy", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync(
      "node",
      ["scripts/test-parallel.mjs", "--explain", "src/auto-reply/reply/followup-runner.test.ts"],
      {
        cwd: repoRoot,
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      },
    );

    expect(output).toContain("surface=base");
    expect(output).toContain("reasons=base-surface,base-pinned-manifest");
    expect(output).toContain("pool=forks");
  });

  it("prints the planner-backed CI manifest as JSON", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const output = execFileSync("node", ["scripts/test-parallel.mjs", "--ci-manifest"], {
      cwd: repoRoot,
      env: {
        ...clearPlannerShardEnv(process.env),
        GITHUB_EVENT_NAME: "pull_request",
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_DOCS_CHANGED: "false",
        OPENCLAW_CI_RUN_NODE: "true",
        OPENCLAW_CI_RUN_MACOS: "true",
        OPENCLAW_CI_RUN_ANDROID: "false",
        OPENCLAW_CI_RUN_WINDOWS: "true",
        OPENCLAW_CI_RUN_SKILLS_PYTHON: "false",
        OPENCLAW_CI_HAS_CHANGED_EXTENSIONS: "false",
        OPENCLAW_CI_CHANGED_EXTENSIONS_MATRIX: '{"include":[]}',
      },
      encoding: "utf8",
    });

    const manifest = JSON.parse(output);
    expect(manifest.jobs.checks.enabled).toBe(true);
    expect(manifest.jobs.macosNode.enabled).toBe(true);
    expect(manifest.jobs.checksWindows.enabled).toBe(true);
  });

  it("writes CI workflow outputs in ci mode", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const outputPath = path.join(os.tmpdir(), `openclaw-ci-output-${Date.now()}.txt`);

    execFileSync("node", ["scripts/ci-write-manifest-outputs.mjs", "--workflow", "ci"], {
      cwd: repoRoot,
      env: {
        ...clearPlannerShardEnv(process.env),
        GITHUB_OUTPUT: outputPath,
        GITHUB_EVENT_NAME: "pull_request",
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_DOCS_CHANGED: "false",
        OPENCLAW_CI_RUN_NODE: "true",
        OPENCLAW_CI_RUN_MACOS: "true",
        OPENCLAW_CI_RUN_ANDROID: "true",
        OPENCLAW_CI_RUN_WINDOWS: "true",
        OPENCLAW_CI_RUN_SKILLS_PYTHON: "false",
        OPENCLAW_CI_HAS_CHANGED_EXTENSIONS: "false",
        OPENCLAW_CI_CHANGED_EXTENSIONS_MATRIX: '{"include":[]}',
      },
      encoding: "utf8",
    });

    const outputs = fs.readFileSync(outputPath, "utf8");
    expect(outputs).toContain("run_build_artifacts=true");
    expect(outputs).toContain("run_checks_windows=true");
    expect(outputs).toContain("run_macos_node=true");
    expect(outputs).toContain("android_matrix=");
    fs.rmSync(outputPath, { force: true });
  });

  it("writes install-smoke outputs in install-smoke mode", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const outputPath = path.join(os.tmpdir(), `openclaw-install-output-${Date.now()}.txt`);

    execFileSync("node", ["scripts/ci-write-manifest-outputs.mjs", "--workflow", "install-smoke"], {
      cwd: repoRoot,
      env: {
        ...clearPlannerShardEnv(process.env),
        GITHUB_OUTPUT: outputPath,
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_RUN_CHANGED_SMOKE: "true",
      },
      encoding: "utf8",
    });

    const outputs = fs.readFileSync(outputPath, "utf8");
    expect(outputs).toContain("run_install_smoke=true");
    expect(outputs).not.toContain("run_checks=");
    fs.rmSync(outputPath, { force: true });
  });

  it("writes bun outputs in ci-bun mode", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const outputPath = path.join(os.tmpdir(), `openclaw-bun-output-${Date.now()}.txt`);

    execFileSync("node", ["scripts/ci-write-manifest-outputs.mjs", "--workflow", "ci-bun"], {
      cwd: repoRoot,
      env: {
        ...clearPlannerShardEnv(process.env),
        GITHUB_OUTPUT: outputPath,
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_RUN_NODE: "true",
      },
      encoding: "utf8",
    });

    const outputs = fs.readFileSync(outputPath, "utf8");
    expect(outputs).toContain("run_bun_checks=true");
    expect(outputs).toContain("bun_checks_matrix=");
    expect(outputs).not.toContain("run_install_smoke=");
    fs.rmSync(outputPath, { force: true });
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
          ...clearPlannerShardEnv(process.env),
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
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      }),
    ).toThrowError(/Unsupported test profile "macmini"/u);
  });

  it("rejects unknown explicit surface names", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--surface", "channel"], {
        cwd: repoRoot,
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      }),
    ).toThrowError(/Unsupported --surface value\(s\): channel/u);
  });

  it("rejects wrapper --files values that look like options", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--files", "--config"], {
        cwd: repoRoot,
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      }),
    ).toThrowError(/Invalid --files value/u);
  });

  it("rejects missing --profile values", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--profile"], {
        cwd: repoRoot,
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      }),
    ).toThrowError(/Invalid --profile value/u);
  });

  it("rejects missing --surface values", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--surface"], {
        cwd: repoRoot,
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      }),
    ).toThrowError(/Invalid --surface value/u);
  });

  it("rejects missing --explain values", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");

    expect(() =>
      execFileSync("node", ["scripts/test-parallel.mjs", "--explain"], {
        cwd: repoRoot,
        env: clearPlannerShardEnv(process.env),
        encoding: "utf8",
      }),
    ).toThrowError(/Invalid --explain value/u);
  });

  it("rejects explicit existing files that are not known test files", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const tempFilePath = path.join(os.tmpdir(), `openclaw-non-test-${Date.now()}.ts`);
    fs.writeFileSync(tempFilePath, "export const notATest = true;\n", "utf8");

    try {
      expect(() =>
        execFileSync("node", ["scripts/test-parallel.mjs", "--plan", "--files", tempFilePath], {
          cwd: repoRoot,
          env: clearPlannerShardEnv(process.env),
          encoding: "utf8",
        }),
      ).toThrowError(/is not a known test file/u);
    } finally {
      fs.rmSync(tempFilePath, { force: true });
    }
  });
});
