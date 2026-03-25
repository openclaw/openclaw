import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createExecutionArtifacts,
  resolvePnpmCommandInvocation,
} from "../../scripts/test-planner/executor.mjs";
import { buildExecutionPlan, explainExecutionTarget } from "../../scripts/test-planner/planner.mjs";

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
    expect(plan.runtimeCapabilities.memoryBand).toBe("mid");
    expect(plan.executionBudget.unitSharedWorkers).toBe(4);
    expect(plan.selectedUnits.some((unit) => unit.id.startsWith("unit-fast"))).toBe(true);
    expect(plan.selectedUnits.some((unit) => unit.id.startsWith("extensions"))).toBe(true);
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
    expect(plan.topLevelParallelLimit).toBe(1);
    expect(plan.deferredRunConcurrency).toBe(1);
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
          "extensions/discord/src/monitor/message-handler.preflight.acp-bindings.test.ts",
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
        fileFilters: ["src/infra/outbound/targets.channel-resolution.test.ts"],
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
    expect(defaultUnitWithSameId).not.toBe(targetedUnit);
    expect(plan.topLevelSingleShardAssignments.get(targetedUnit)).toBeUndefined();
    expect(plan.topLevelSingleShardAssignments.get(defaultUnitWithSameId)).toBeDefined();

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
