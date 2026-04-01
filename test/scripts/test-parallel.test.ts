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
import { loadTestCatalog } from "../../scripts/test-planner/catalog.mjs";
import { bundledPluginFile } from "../helpers/bundled-plugin-paths.js";

const clearPlannerShardEnv = (env) => {
  const nextEnv = { ...env };
  delete nextEnv.OPENCLAW_TEST_SHARDS;
  delete nextEnv.OPENCLAW_TEST_SHARD_INDEX;
  delete nextEnv.OPENCLAW_TEST_FORCE_THREADS;
  delete nextEnv.OPENCLAW_TEST_FORCE_FORKS;
  delete nextEnv.OPENCLAW_TEST_DISABLE_THREAD_EXPANSION;
  delete nextEnv.OPENCLAW_TEST_SHOW_POOL_DECISION;
  delete nextEnv.OPENCLAW_TEST_PROFILE;
  delete nextEnv.OPENCLAW_TEST_WORKERS;
  delete nextEnv.OPENCLAW_TEST_SKIP_DEFAULT;
  delete nextEnv.OPENCLAW_TEST_INCLUDE_EXTENSIONS;
  delete nextEnv.OPENCLAW_TEST_INCLUDE_CHANNELS;
  delete nextEnv.OPENCLAW_TEST_INCLUDE_GATEWAY;
  return nextEnv;
};

const sharedTargetedChannelProxyFiles = (() => {
  const catalog = loadTestCatalog();
  return catalog.allKnownTestFiles
    .filter((file) => {
      const classification = catalog.classifyTestFile(file);
      return classification.surface === "channels" && !classification.isolated;
    })
    .slice(0, 100);
})();

const sharedTargetedUnitProxyFiles = (() => {
  const catalog = loadTestCatalog();
  return catalog.allKnownTestFiles
    .filter((file) => {
      const classification = catalog.classifyTestFile(file);
      return classification.surface === "unit" && !classification.isolated;
    })
    .slice(0, 100);
})();

const targetedChannelProxyFiles = [
  ...sharedTargetedChannelProxyFiles,
  bundledPluginFile("discord", "src/monitor/message-handler.preflight.acp-bindings.test.ts"),
  bundledPluginFile("discord", "src/monitor/monitor.agent-components.test.ts"),
  bundledPluginFile("telegram", "src/bot.create-telegram-bot.test.ts"),
  bundledPluginFile("whatsapp", "src/monitor-inbox.streams-inbound-messages.test.ts"),
];

const targetedUnitProxyFiles = [
  ...sharedTargetedUnitProxyFiles,
  "src/cli/qr-dashboard.integration.test.ts",
];

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const HIGH_MEMORY_LOCAL_PLANNER_ENV = {
  RUNNER_OS: "macOS",
  OPENCLAW_TEST_HOST_CPU_COUNT: "12",
  OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
} as const;

function createPlannerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...clearPlannerShardEnv(process.env),
    ...overrides,
  };
}

function createLocalPlannerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return createPlannerEnv({
    CI: "",
    GITHUB_ACTIONS: "",
    OPENCLAW_TEST_LOAD_AWARE: "0",
    ...overrides,
  });
}

function createHighMemoryLocalPlannerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return createLocalPlannerEnv({
    ...HIGH_MEMORY_LOCAL_PLANNER_ENV,
    ...overrides,
  });
}

function runPlannerPlan(args: string[], envOverrides: NodeJS.ProcessEnv = {}): string {
  return execFileSync("node", ["scripts/test-parallel.mjs", ...args], {
    cwd: REPO_ROOT,
    env: createPlannerEnv(envOverrides),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runHighMemoryLocalMultiSurfacePlan(): string {
  return runPlannerPlan(
    ["--plan", "--surface", "unit", "--surface", "extensions", "--surface", "channels"],
    createHighMemoryLocalPlannerEnv(),
  );
}

function getPlanLines(output: string, prefix: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}

function getTargetedChannelPlanLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("channels-") &&
        line.includes("filters=") &&
        line.includes("surface=channels"),
    );
}

function parseNumericPlanField(line: string, key: string): number {
  const match = line.match(new RegExp(`\\b${key}=(\\d+)\\b`));
  if (!match) {
    throw new Error(`missing ${key} in plan line: ${line}`);
  }
  return Number(match[1]);
}

function runManifestOutputWriter(workflow: string, envOverrides: NodeJS.ProcessEnv = {}): string {
  const outputPath = path.join(os.tmpdir(), `openclaw-${workflow}-output-${Date.now()}.txt`);
  try {
    execFileSync("node", ["scripts/ci-write-manifest-outputs.mjs", "--workflow", workflow], {
      cwd: REPO_ROOT,
      env: createPlannerEnv({
        GITHUB_OUTPUT: outputPath,
        ...envOverrides,
      }),
      encoding: "utf8",
    });
    return fs.readFileSync(outputPath, "utf8");
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
}
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
    const output = runPlannerPlan(["--plan"], {
      OPENCLAW_TEST_PROFILE: "serial",
    });

    expect(output).toContain("unit-fast");
    expect(output).not.toContain("unit filters=all maxWorkers=1");
  });

  it("recycles default local unit-fast runs into bounded batches", () => {
    const output = runPlannerPlan(["--plan"], {
      CI: "",
      OPENCLAW_TEST_UNIT_FAST_LANES: "1",
      OPENCLAW_TEST_UNIT_FAST_BATCH_TARGET_MS: "1",
    });

    expect(output).toContain("unit-fast-batch-");
    expect(output).not.toContain("unit-fast filters=all maxWorkers=");
  });

  it("keeps legacy base-pinned targeted reruns on dedicated forks lanes", () => {
    const output = runPlannerPlan([
      "--plan",
      "--files",
      "src/auto-reply/reply/followup-runner.test.ts",
    ]);

    expect(output).toContain("base-pinned-followup-runner");
    expect(output).not.toContain("base-followup-runner");
  });

  it("reports capability-derived output for mid-memory local macOS hosts", () => {
    const output = runPlannerPlan(
      ["--plan", "--surface", "unit", "--surface", "extensions"],
      createLocalPlannerEnv({
        RUNNER_OS: "macOS",
        OPENCLAW_TEST_HOST_CPU_COUNT: "10",
        OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
      }),
    );

    expect(output).toContain("mode=local intent=normal memoryBand=mid");
    expect(output).toMatch(/unit-fast(?:-batch-\d+)? filters=\d+ maxWorkers=/);
    expect(output).toMatch(/extensions(?:-batch-\d+)? filters=\d+ maxWorkers=/);
  });

  it("uses higher shared extension worker counts on high-memory local hosts", () => {
    const highMemoryOutput = runPlannerPlan(
      ["--plan", "--surface", "extensions"],
      createHighMemoryLocalPlannerEnv(),
    );
    const midMemoryOutput = runPlannerPlan(
      ["--plan", "--surface", "extensions"],
      createLocalPlannerEnv({
        RUNNER_OS: "macOS",
        OPENCLAW_TEST_HOST_CPU_COUNT: "10",
        OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
      }),
    );

    const midSharedBatches = getPlanLines(midMemoryOutput, "extensions-batch-");
    const highSharedBatches = getPlanLines(highMemoryOutput, "extensions-batch-");

    expect(midSharedBatches.length).toBeGreaterThan(0);
    expect(highSharedBatches.length).toBeGreaterThan(0);
    expect(midSharedBatches.every((line) => /filters=\d+ maxWorkers=3/.test(line))).toBe(true);
    expect(highSharedBatches.every((line) => /filters=\d+ maxWorkers=5/.test(line))).toBe(true);
    expect(highSharedBatches.length).toBeLessThanOrEqual(midSharedBatches.length);
  });

  it("starts isolated channel lanes before shared extension batches on high-memory local hosts", () => {
    const output = runHighMemoryLocalMultiSurfacePlan();

    const firstChannelIsolated = output.indexOf(
      "message-handler.preflight.acp-bindings-channels-isolated",
    );
    const firstExtensionBatch = output.indexOf("extensions-batch-1");
    const firstChannelBatch = output.indexOf("channels-batch-1");
    expect(firstChannelIsolated).toBeGreaterThanOrEqual(0);
    expect(firstExtensionBatch).toBeGreaterThan(firstChannelIsolated);
    expect(firstChannelBatch).toBeGreaterThan(firstExtensionBatch);
    expect(output).toMatch(/channels-batch-1 filters=\d+ maxWorkers=5/);
  });

  it("uses coarser unit-fast batching for high-memory local multi-surface runs", () => {
    const output = runHighMemoryLocalMultiSurfacePlan();

    expect(output).toContain("unit-fast-batch-4");
    expect(output).not.toContain("unit-fast-batch-5");
  });

  it("uses earlier targeted channel batching on high-memory local hosts", () => {
    const output = runPlannerPlan(
      [
        "--plan",
        "--surface",
        "channels",
        ...targetedChannelProxyFiles.flatMap((file) => ["--files", file]),
      ],
      createHighMemoryLocalPlannerEnv(),
    );

    const channelBatchLines = getPlanLines(output, "channels-batch-");
    const channelBatchFilterCounts = channelBatchLines.map((line) =>
      parseNumericPlanField(line, "filters"),
    );
    const targetedChannelPlanLines = getTargetedChannelPlanLines(output);

    expect(channelBatchLines.length).toBeGreaterThanOrEqual(4);
    expect(channelBatchLines.every((line) => line.includes("maxWorkers=5"))).toBe(true);
    expect(Math.max(...channelBatchFilterCounts)).toBeLessThan(30);
    expect(
      targetedChannelPlanLines.reduce(
        (sum, line) => sum + parseNumericPlanField(line, "filters"),
        0,
      ),
    ).toBe(targetedChannelProxyFiles.length);
  });

  it("uses targeted unit batching on high-memory local hosts", () => {
    const output = runPlannerPlan(
      [
        "--plan",
        "--surface",
        "unit",
        ...targetedUnitProxyFiles.flatMap((file) => ["--files", file]),
      ],
      createHighMemoryLocalPlannerEnv(),
    );

    const unitBatchLines = getPlanLines(output, "unit-batch-");
    const unitBatchFilterCounts = unitBatchLines.map((line) =>
      parseNumericPlanField(line, "filters"),
    );

    expect(unitBatchLines.length).toBeGreaterThanOrEqual(3);
    expect(unitBatchLines.every((line) => line.includes("maxWorkers=6"))).toBe(true);
    expect(Math.max(...unitBatchFilterCounts)).toBeLessThan(40);
    expect(unitBatchFilterCounts.reduce((sum, count) => sum + count, 0)).toBe(
      sharedTargetedUnitProxyFiles.length,
    );
    expect(output).toContain("unit-qr-dashboard.integration-isolated filters=1 maxWorkers=2");
  });

  it("explains targeted file ownership and execution policy", () => {
    const output = runPlannerPlan(["--explain", "src/auto-reply/reply/followup-runner.test.ts"]);

    expect(output).toContain("surface=base");
    expect(output).toContain("reasons=base-surface,base-pinned-manifest");
    expect(output).toContain("pool=forks");
  });

  it("routes targeted contract tests through the contracts config", () => {
    const output = runPlannerPlan([
      "--explain",
      "src/channels/plugins/contracts/registry-backed.contract.test.ts",
    ]);

    expect(output).toContain("surface=contracts");
    expect(output).toContain("vitest.contracts.config.ts");
    expect(output).not.toContain("vitest.unit.config.ts");
  });

  it("prints the planner-backed CI manifest as JSON", () => {
    const output = runPlannerPlan(["--ci-manifest"], {
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
    });

    const manifest = JSON.parse(output);
    expect(manifest.jobs.checks.enabled).toBe(true);
    expect(manifest.jobs.macosNode.enabled).toBe(true);
    expect(manifest.jobs.checksWindows.enabled).toBe(true);
  });

  it("writes CI workflow outputs in ci mode", () => {
    const outputs = runManifestOutputWriter("ci", {
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
    });
    expect(outputs).toContain("run_build_artifacts=true");
    expect(outputs).toContain("run_checks_windows=true");
    expect(outputs).toContain("run_macos_node=true");
    expect(outputs).toContain("android_matrix=");
  });

  it("writes install-smoke outputs in install-smoke mode", () => {
    const outputs = runManifestOutputWriter("install-smoke", {
      OPENCLAW_CI_DOCS_ONLY: "false",
      OPENCLAW_CI_RUN_CHANGED_SMOKE: "true",
    });
    expect(outputs).toContain("run_install_smoke=true");
    expect(outputs).not.toContain("run_checks=");
  });

  it("passes through vitest --mode values that are not wrapper runtime overrides", () => {
    const output = runPlannerPlan(
      ["--plan", "--mode", "development", "src/infra/outbound/deliver.test.ts"],
      createLocalPlannerEnv({
        RUNNER_OS: "Linux",
        OPENCLAW_TEST_HOST_CPU_COUNT: "16",
        OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
      }),
    );

    expect(output).toContain("mode=local intent=normal memoryBand=high");
    expect(output).toContain("unit-deliver-isolated filters=1");
  });

  it("prints collect-all failure policy in planner output for wrapper-native flag", () => {
    const output = runPlannerPlan(["--plan", "--collect-failures", "--surface", "unit"]);

    expect(output).toContain("failurePolicy=collect-all");
  });

  it("maps --bail=0 to collect-all failure policy in planner output", () => {
    const output = runPlannerPlan(["--plan", "--surface", "unit", "--", "--bail=0"]);

    expect(output).toContain("failurePolicy=collect-all");
  });

  it("rejects wrapper-level positive --bail values", () => {
    expect(() => runPlannerPlan(["--plan", "--surface", "unit", "--", "--bail=2"])).toThrowError(
      /Unsupported wrapper-level --bail value/u,
    );
  });

  it("rejects removed machine-name profiles", () => {
    expect(() => runPlannerPlan(["--plan", "--profile", "macmini"])).toThrowError(
      /Unsupported test profile "macmini"/u,
    );
  });

  it("rejects unknown explicit surface names", () => {
    expect(() => runPlannerPlan(["--plan", "--surface", "channel"])).toThrowError(
      /Unsupported --surface value\(s\): channel/u,
    );
  });

  it("supports the explicit contracts surface", () => {
    const output = runPlannerPlan(["--plan", "--surface", "contracts"]);

    expect(output).toContain("contracts filters=all");
    expect(output).toContain("surface=contracts");
  });

  it("rejects wrapper --files values that look like options", () => {
    expect(() => runPlannerPlan(["--plan", "--files", "--config"])).toThrowError(
      /Invalid --files value/u,
    );
  });

  it("rejects missing --profile values", () => {
    expect(() => runPlannerPlan(["--plan", "--profile"])).toThrowError(/Invalid --profile value/u);
  });

  it("rejects missing --surface values", () => {
    expect(() => runPlannerPlan(["--plan", "--surface"])).toThrowError(/Invalid --surface value/u);
  });

  it("rejects missing --explain values", () => {
    expect(() => runPlannerPlan(["--explain"])).toThrowError(/Invalid --explain value/u);
  });

  it("rejects explicit existing files that are not known test files", () => {
    const tempFilePath = path.join(os.tmpdir(), `openclaw-non-test-${Date.now()}.ts`);
    fs.writeFileSync(tempFilePath, "export const notATest = true;\n", "utf8");

    try {
      expect(() => runPlannerPlan(["--plan", "--files", tempFilePath])).toThrowError(
        /is not a known test file/u,
      );
    } finally {
      fs.rmSync(tempFilePath, { force: true });
    }
  });
});
