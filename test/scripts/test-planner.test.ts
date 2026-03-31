import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExecutionArtifacts,
  createTempArtifactWriteStream,
  resolvePnpmCommandInvocation,
  resolveVitestFsModuleCachePath,
} from "../../scripts/test-planner/executor.mjs";
import {
  buildCIExecutionManifest,
  buildExecutionPlan,
  explainExecutionTarget,
} from "../../scripts/test-planner/planner.mjs";
import { bundledPluginFile } from "../helpers/bundled-plugin-paths.js";

describe("test planner", () => {
  it("builds a capability-aware plan for mid-memory local runs", () => {
    const artifacts = createExecutionArtifacts({
      RUNNER_OS: "macOS",
      OPENCLAW_TEST_HOST_CPU_COUNT: "10",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
      OPENCLAW_TEST_LOAD_AWARE: "0",
    });
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "local",
        surfaces: ["unit", "extensions"],
        passthroughArgs: [],
      },
      {
        env: {
          RUNNER_OS: "macOS",
          OPENCLAW_TEST_HOST_CPU_COUNT: "10",
          OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
          OPENCLAW_TEST_LOAD_AWARE: "0",
        },
        platform: "darwin",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    expect(plan.runtimeCapabilities.runtimeProfileName).toBe("local-darwin");
    expect(plan.failurePolicy).toBe("fail-fast");
    expect(plan.runtimeCapabilities.memoryBand).toBe("mid");
    expect(plan.executionBudget.unitSharedWorkers).toBe(4);
    expect(plan.executionBudget.topLevelParallelLimitNoIsolate).toBe(8);
    expect(plan.executionBudget.topLevelParallelLimitIsolated).toBe(3);
    expect(plan.selectedUnits.some((unit) => unit.id.startsWith("unit-fast"))).toBe(true);
    expect(plan.selectedUnits.some((unit) => unit.id.startsWith("extensions"))).toBe(true);
    expect(plan.topLevelParallelLimit).toBe(8);
    artifacts.cleanupTempArtifacts();
  });

  it("uses smaller shared extension batches on constrained local hosts", () => {
    const env = {
      RUNNER_OS: "macOS",
      OPENCLAW_TEST_HOST_CPU_COUNT: "8",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "16",
      OPENCLAW_TEST_LOAD_AWARE: "0",
    };
    const artifacts = createExecutionArtifacts(env);
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "local",
        surfaces: ["extensions"],
        passthroughArgs: [],
      },
      {
        env,
        platform: "darwin",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const sharedExtensionBatches = plan.selectedUnits.filter((unit) =>
      unit.id.startsWith("extensions-batch-"),
    );

    expect(plan.runtimeCapabilities.memoryBand).toBe("constrained");
    expect(plan.executionBudget.extensionsBatchTargetMs).toBe(60_000);
    expect(sharedExtensionBatches.length).toBeGreaterThan(3);
    artifacts.cleanupTempArtifacts();
  });

  it("caps CI extension batch concurrency when multiple shared batches are scheduled", () => {
    const env = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "Linux",
      OPENCLAW_TEST_HOST_CPU_COUNT: "4",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "16",
    };
    const artifacts = createExecutionArtifacts(env);
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "ci",
        surfaces: ["extensions"],
        passthroughArgs: [],
      },
      {
        env,
        platform: "linux",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const sharedExtensionBatches = plan.selectedUnits.filter(
      (unit) => unit.surface === "extensions" && !unit.isolate,
    );

    expect(plan.runtimeCapabilities.runtimeProfileName).toBe("ci-linux");
    expect(plan.executionBudget.topLevelParallelLimitNoIsolate).toBe(4);
    expect(sharedExtensionBatches.length).toBeGreaterThan(1);
    expect(plan.topLevelParallelLimit).toBe(3);
    artifacts.cleanupTempArtifacts();
  });

  it("auto-isolates timed-heavy extension suites in CI", () => {
    const env = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "Linux",
      OPENCLAW_TEST_HOST_CPU_COUNT: "4",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "16",
    };
    const artifacts = createExecutionArtifacts(env);
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "ci",
        surfaces: ["extensions"],
        passthroughArgs: [],
      },
      {
        env,
        platform: "linux",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const hotspotUnit = plan.selectedUnits.find(
      (unit) => unit.id === "extensions-plugin-entry.runtime-isolated",
    );

    expect(hotspotUnit).toBeTruthy();
    expect(hotspotUnit?.isolate).toBe(true);
    expect(hotspotUnit?.reasons).toContain("extensions-timed-heavy");
    artifacts.cleanupTempArtifacts();
  });

  it("scales down mid-tier local concurrency under saturated load", () => {
    const artifacts = createExecutionArtifacts({
      RUNNER_OS: "Linux",
      OPENCLAW_TEST_HOST_CPU_COUNT: "10",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
    });
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "local",
        surfaces: ["unit", "extensions"],
        passthroughArgs: [],
      },
      {
        env: {
          RUNNER_OS: "Linux",
          OPENCLAW_TEST_HOST_CPU_COUNT: "10",
          OPENCLAW_TEST_HOST_MEMORY_GIB: "64",
        },
        platform: "linux",
        loadAverage: [11.5, 11.5, 11.5],
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    expect(plan.runtimeCapabilities.memoryBand).toBe("mid");
    expect(plan.runtimeCapabilities.loadBand).toBe("saturated");
    expect(plan.executionBudget.unitSharedWorkers).toBe(2);
    expect(plan.executionBudget.unitIsolatedWorkers).toBe(1);
    expect(plan.executionBudget.topLevelParallelLimitNoIsolate).toBe(4);
    expect(plan.executionBudget.topLevelParallelLimitIsolated).toBe(1);
    expect(plan.topLevelParallelLimit).toBe(4);
    expect(plan.deferredRunConcurrency).toBe(1);
    artifacts.cleanupTempArtifacts();
  });

  it("splits saturated high-memory local unit bursts into smaller shared batches", () => {
    const env = {
      RUNNER_OS: "macOS",
      OPENCLAW_TEST_HOST_CPU_COUNT: "16",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
    };
    const artifacts = createExecutionArtifacts(env);
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "local",
        surfaces: ["unit"],
        passthroughArgs: [],
      },
      {
        env,
        platform: "darwin",
        loadAverage: [18, 18, 18],
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const sharedUnitBatches = plan.selectedUnits.filter(
      (unit) => unit.surface === "unit" && !unit.isolate && unit.id.startsWith("unit-fast"),
    );
    const baselinePlan = buildExecutionPlan(
      {
        profile: null,
        mode: "local",
        surfaces: ["unit"],
        passthroughArgs: [],
      },
      {
        env,
        platform: "darwin",
        loadAverage: [1, 1, 1],
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );
    const baselineSharedUnitBatches = baselinePlan.selectedUnits.filter(
      (unit) => unit.surface === "unit" && !unit.isolate && unit.id.startsWith("unit-fast"),
    );

    expect(plan.runtimeCapabilities.memoryBand).toBe("high");
    expect(plan.runtimeCapabilities.loadBand).toBe("saturated");
    expect(sharedUnitBatches.length).toBeGreaterThan(baselineSharedUnitBatches.length);
    expect(plan.executionBudget.unitIsolatedWorkers).toBe(1);
    expect(plan.executionBudget.unitFastBatchTargetMs).toBe(22_500);
    artifacts.cleanupTempArtifacts();
  });

  it("keeps full local unit runs phased when isolated and heavy lanes are present", () => {
    const env = {
      RUNNER_OS: "macOS",
      OPENCLAW_TEST_HOST_CPU_COUNT: "16",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
      OPENCLAW_TEST_LOAD_AWARE: "0",
    };
    const artifacts = createExecutionArtifacts(env);
    const plan = buildExecutionPlan(
      {
        profile: null,
        mode: "local",
        surfaces: ["unit"],
        passthroughArgs: [],
      },
      {
        env,
        platform: "darwin",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const sharedUnitBatches = plan.selectedUnits.filter(
      (unit) => unit.surface === "unit" && !unit.isolate && unit.id.startsWith("unit-fast"),
    );

    expect(sharedUnitBatches.length).toBeGreaterThanOrEqual(4);
    expect(plan.serialPrefixUnits.some((unit) => unit.serialPhase === "unit-fast")).toBe(true);
    expect(plan.topLevelParallelLimit).toBe(3);
    artifacts.cleanupTempArtifacts();
  });

  it("honors the max-profile top-level no-isolate cap without adding extra lanes", () => {
    const artifacts = createExecutionArtifacts({
      RUNNER_OS: "Linux",
      OPENCLAW_TEST_HOST_CPU_COUNT: "16",
      OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
      OPENCLAW_TEST_LOAD_AWARE: "0",
      OPENCLAW_TEST_PROFILE: "max",
    });
    const plan = buildExecutionPlan(
      {
        profile: "max",
        mode: "local",
        surfaces: ["unit", "extensions"],
        passthroughArgs: [],
      },
      {
        env: {
          RUNNER_OS: "Linux",
          OPENCLAW_TEST_HOST_CPU_COUNT: "16",
          OPENCLAW_TEST_HOST_MEMORY_GIB: "128",
          OPENCLAW_TEST_LOAD_AWARE: "0",
          OPENCLAW_TEST_PROFILE: "max",
        },
        platform: "linux",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    expect(plan.runtimeCapabilities.intentProfile).toBe("max");
    expect(plan.executionBudget.topLevelParallelLimitNoIsolate).toBe(8);
    expect(plan.topLevelParallelLimit).toBe(8);
    artifacts.cleanupTempArtifacts();
  });

  it("splits mixed targeted file selections across surfaces", () => {
    const artifacts = createExecutionArtifacts({});
    const plan = buildExecutionPlan(
      {
        mode: "local",
        surfaces: [],
        passthroughArgs: [
          "src/auto-reply/reply/followup-runner.test.ts",
          bundledPluginFile(
            "discord",
            "src/monitor/message-handler.preflight.acp-bindings.test.ts",
          ),
        ],
      },
      {
        env: {},
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    expect(plan.targetedUnits).toHaveLength(2);
    expect(
      plan.targetedUnits
        .map((unit) => unit.surface)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["base", "channels"]);
    artifacts.cleanupTempArtifacts();
  });

  it("normalizes --bail=0 into collect-all failure policy", () => {
    const artifacts = createExecutionArtifacts({});
    const plan = buildExecutionPlan(
      {
        mode: "local",
        surfaces: ["unit"],
        passthroughArgs: ["--bail=0"],
      },
      {
        env: {},
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    expect(plan.failurePolicy).toBe("collect-all");
    expect(plan.passthroughOptionArgs).not.toContain("--bail=0");
    artifacts.cleanupTempArtifacts();
  });

  it("explains runtime truth using the same catalog and worker policy", () => {
    const explanation = explainExecutionTarget(
      {
        mode: "local",
        fileFilters: ["src/auto-reply/reply/followup-runner.test.ts"],
      },
      {
        env: {},
      },
    );

    expect(explanation.surface).toBe("base");
    expect(explanation.pool).toBe("forks");
    expect(explanation.reasons).toContain("base-pinned-manifest");
    expect(explanation.intentProfile).toBe("normal");
  });

  it("uses hotspot-backed memory isolation when explaining unit tests", () => {
    const explanation = explainExecutionTarget(
      {
        mode: "local",
        fileFilters: ["src/infra/outbound/channel-resolution.test.ts"],
      },
      {
        env: {
          OPENCLAW_TEST_LOAD_AWARE: "0",
        },
      },
    );

    expect(explanation.isolate).toBe(true);
    expect(explanation.reasons).toContain("unit-memory-isolated");
  });

  it("normalizes absolute explain targets before classification", () => {
    const relativeExplanation = explainExecutionTarget(
      {
        mode: "local",
        fileFilters: ["src/infra/outbound/channel-resolution.test.ts"],
      },
      {
        env: {
          OPENCLAW_TEST_LOAD_AWARE: "0",
        },
      },
    );
    const absoluteExplanation = explainExecutionTarget(
      {
        mode: "local",
        fileFilters: [path.join(process.cwd(), "src/infra/outbound/channel-resolution.test.ts")],
      },
      {
        env: {
          OPENCLAW_TEST_LOAD_AWARE: "0",
        },
      },
    );

    expect(absoluteExplanation.file).toBe(relativeExplanation.file);
    expect(absoluteExplanation.surface).toBe(relativeExplanation.surface);
    expect(absoluteExplanation.pool).toBe(relativeExplanation.pool);
    expect(absoluteExplanation.isolate).toBe(relativeExplanation.isolate);
    expect(absoluteExplanation.reasons).toEqual(relativeExplanation.reasons);
  });

  it("explains timed-heavy extension suites as isolated", () => {
    const explanation = explainExecutionTarget(
      {
        mode: "ci",
        fileFilters: ["extensions/matrix/src/plugin-entry.runtime.test.ts"],
      },
      {
        env: {
          CI: "true",
          GITHUB_ACTIONS: "true",
        },
      },
    );

    expect(explanation.surface).toBe("extensions");
    expect(explanation.isolate).toBe(true);
    expect(explanation.reasons).toContain("extensions-timed-heavy");
  });

  it("does not leak default-plan shard assignments into targeted units with the same id", () => {
    const artifacts = createExecutionArtifacts({});
    const plan = buildExecutionPlan(
      {
        mode: "local",
        fileFilters: ["src/cli/qr-dashboard.integration.test.ts"],
        passthroughArgs: [],
      },
      {
        env: {
          OPENCLAW_TEST_SHARDS: "4",
          OPENCLAW_TEST_SHARD_INDEX: "2",
          OPENCLAW_TEST_LOAD_AWARE: "0",
        },
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const targetedUnit = plan.targetedUnits.at(0);
    const defaultUnitWithSameId = plan.allUnits.find((unit) => unit.id === targetedUnit?.id);

    expect(targetedUnit).toBeTruthy();
    expect(defaultUnitWithSameId).toBeTruthy();
    const targetedUnitRecord = targetedUnit!;
    const defaultUnitRecord = defaultUnitWithSameId as typeof targetedUnitRecord;

    expect(defaultUnitRecord).not.toBe(targetedUnitRecord);
    expect(plan.topLevelSingleShardAssignments.get(targetedUnitRecord)).toBeUndefined();
    expect(plan.topLevelSingleShardAssignments.get(defaultUnitRecord)).toBeDefined();

    artifacts.cleanupTempArtifacts();
  });

  it("pins the smallest CI include-file batches to fixed shards", () => {
    const env = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      OPENCLAW_TEST_SHARDS: "4",
      OPENCLAW_TEST_SHARD_INDEX: "1",
      OPENCLAW_TEST_LOAD_AWARE: "0",
    };
    const artifacts = createExecutionArtifacts(env);
    const plan = buildExecutionPlan(
      {
        mode: "ci",
        passthroughArgs: [],
      },
      {
        env,
        platform: "linux",
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const shardableUnits = plan.parallelUnits.filter(
      (unit) =>
        unit.id.startsWith("unit-fast-") &&
        Array.isArray(unit.includeFiles) &&
        unit.includeFiles.length > 0,
    );
    const smallestIncludeCount = Math.min(
      ...shardableUnits.map((unit) => unit.includeFiles.length),
    );
    const smallestBatches = shardableUnits.filter(
      (unit) => unit.includeFiles.length === smallestIncludeCount,
    );

    expect(smallestBatches.length).toBeGreaterThan(0);
    expect(smallestBatches.every((unit) => typeof unit.fixedShardIndex === "number")).toBe(true);
    expect(
      smallestBatches.every((unit) => plan.topLevelSingleShardAssignments.get(unit) === undefined),
    ).toBe(true);

    artifacts.cleanupTempArtifacts();
  });

  it("removes planner temp artifacts when cleanup runs after planning", () => {
    const artifacts = createExecutionArtifacts({});
    buildExecutionPlan(
      {
        mode: "local",
        surfaces: ["unit"],
        passthroughArgs: [],
      },
      {
        env: {},
        writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
      },
    );

    const artifactDir = artifacts.ensureTempArtifactDir();
    expect(fs.existsSync(artifactDir)).toBe(true);
    artifacts.cleanupTempArtifacts();
    expect(fs.existsSync(artifactDir)).toBe(false);
  });

  it("keeps fd-backed artifact streams writable after temp cleanup", async () => {
    const artifacts = createExecutionArtifacts({});
    const artifactDir = artifacts.ensureTempArtifactDir();
    const logPath = path.join(artifactDir, "lane.log");
    const stream = createTempArtifactWriteStream(logPath);

    stream.write("before cleanup\n");
    artifacts.cleanupTempArtifacts();

    await expect(
      new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        stream.write("after cleanup\n");
        stream.end(() => resolve());
      }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(artifactDir)).toBe(false);
  });

  it("builds a CI manifest with planner-owned shard counts and matrices", () => {
    const manifest = buildCIExecutionManifest(
      {
        eventName: "pull_request",
        docsOnly: false,
        docsChanged: false,
        runNode: true,
        runMacos: true,
        runAndroid: true,
        runWindows: true,
        runSkillsPython: false,
        hasChangedExtensions: true,
        changedExtensionsMatrix: { include: [{ extension: "discord" }] },
      },
      {
        env: {},
      },
    );

    expect(manifest.jobs.buildArtifacts.enabled).toBe(true);
    expect(manifest.shardCounts.unit).toBe(4);
    expect(manifest.shardCounts.channels).toBe(3);
    expect(manifest.shardCounts.windows).toBe(6);
    expect(manifest.shardCounts.macosNode).toBe(9);
    expect(manifest.shardCounts.bun).toBe(6);
    expect(manifest.jobs.checks.matrix.include).toHaveLength(7);
    expect(manifest.jobs.checksWindows.matrix.include).toHaveLength(6);
    expect(manifest.jobs.bunChecks.matrix.include).toHaveLength(6);
    expect(manifest.jobs.macosNode.matrix.include).toHaveLength(9);
    expect(manifest.jobs.macosSwift.enabled).toBe(true);
    expect(manifest.requiredCheckNames).toContain("macos-swift");
    expect(manifest.requiredCheckNames).not.toContain("macos-swift-lint");
    expect(manifest.requiredCheckNames).not.toContain("macos-swift-build");
    expect(manifest.requiredCheckNames).not.toContain("macos-swift-test");
    expect(manifest.jobs.extensionFast.matrix.include).toEqual([
      { check_name: "extension-fast-discord", extension: "discord" },
    ]);
  });

  it("suppresses heavy CI jobs in docs-only manifests", () => {
    const manifest = buildCIExecutionManifest(
      {
        eventName: "pull_request",
        docsOnly: true,
        docsChanged: true,
        runNode: false,
        runMacos: false,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        hasChangedExtensions: false,
      },
      {
        env: {},
      },
    );

    expect(manifest.jobs.buildArtifacts.enabled).toBe(false);
    expect(manifest.jobs.checks.enabled).toBe(false);
    expect(manifest.jobs.checksWindows.enabled).toBe(false);
    expect(manifest.jobs.macosNode.enabled).toBe(false);
    expect(manifest.jobs.checkDocs.enabled).toBe(true);
  });

  it("adds the push-only compat lane to push manifests", () => {
    const manifest = buildCIExecutionManifest(
      {
        eventName: "push",
        docsOnly: false,
        docsChanged: false,
        runNode: true,
        runMacos: false,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        hasChangedExtensions: false,
      },
      {
        env: {},
      },
    );

    expect(
      manifest.jobs.checks.matrix.include.some((entry) => entry.task === "compat-node22"),
    ).toBe(true);
  });
});

describe("resolvePnpmCommandInvocation", () => {
  it("prefers the parent pnpm CLI path when npm_execpath points to pnpm", () => {
    expect(
      resolvePnpmCommandInvocation({
        npmExecPath: "/opt/homebrew/lib/node_modules/corepack/dist/pnpm.cjs",
        nodeExecPath: "/usr/local/bin/node",
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/node",
      args: ["/opt/homebrew/lib/node_modules/corepack/dist/pnpm.cjs"],
    });
  });

  it("falls back to cmd.exe mediation on Windows when npm_execpath is unavailable", () => {
    expect(
      resolvePnpmCommandInvocation({
        npmExecPath: "",
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd"],
    });
  });
});

describe("resolveVitestFsModuleCachePath", () => {
  it("uses a lane-local cache path by default on non-Windows hosts", () => {
    expect(
      resolveVitestFsModuleCachePath({
        cwd: "/repo",
        env: {},
        platform: "linux",
        unitId: "unit-fast-1",
      }),
    ).toBe("/repo/node_modules/.experimental-vitest-cache/unit-fast-1");
  });

  it("honors the requested Windows platform when building the cache path", () => {
    expect(
      resolveVitestFsModuleCachePath({
        cwd: "/repo",
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
        },
        platform: "win32",
        unitId: "unit-fast-1",
      }),
    ).toBe("\\repo\\node_modules\\.experimental-vitest-cache\\unit-fast-1");
  });

  it("respects an explicit cache path override", () => {
    expect(
      resolveVitestFsModuleCachePath({
        cwd: "/repo",
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/custom-vitest-cache",
        },
        platform: "linux",
        unitId: "unit-fast-1",
      }),
    ).toBe("/tmp/custom-vitest-cache");
  });

  it("does not force a cache path when the cache is disabled", () => {
    expect(
      resolveVitestFsModuleCachePath({
        cwd: "/repo",
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "0",
        },
        platform: "linux",
        unitId: "unit-fast-1",
      }),
    ).toBeUndefined();
  });
});
