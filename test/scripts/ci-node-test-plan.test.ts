// Ci Node Test Plan tests cover ci node test plan script behavior.
import { existsSync, globSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join, matchesGlob, relative } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createChangedExtensionFallbackShards,
  createChangedNodeTestShards,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  type CompactNodeTestShard,
  createNodeTestShardBundles,
  createNodeTestShards,
  createSelectedNodeTestShardBundles,
  createUiTestShardGroups,
  createVitestCacheWarmGroups,
  hasCompleteStartupCorpusCoverage,
  isExclusiveCompactShardName,
  isPolicyTestOwnedPath,
  packNodeTestGroups,
  resolvePolicyTestTargets,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { isCiProofTestFile } from "../../scripts/lib/ci-proof-test-inventory.mts";
import { isRuntimePlacementIncludePatterns } from "../../scripts/lib/ci-test-timings-schema.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { isExclusiveCiTestConfig } from "../../scripts/lib/local-check-runtime.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { listVitestRuntimeConsumerFiles } from "../../scripts/lib/vitest-build-prerequisites.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  createCompactSplitTimingGeneration,
  parseCompactSplitTimingKey,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import { createVitestRunSpecs } from "../../scripts/test-projects.test-support.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";
import { toRepoPath } from "../../src/test-utils/repo-files.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createAgentsCoreIsolatedVitestConfig } from "../vitest/vitest.agents-core-isolated.config.ts";
import { createAgentsCoreVitestConfig } from "../vitest/vitest.agents-core.config.ts";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../vitest/vitest.agents-paths.mjs";
import { createAgentsSupportVitestConfig } from "../vitest/vitest.agents-support.config.ts";
import { createAgentsToolsVitestConfig } from "../vitest/vitest.agents-tools.config.ts";
import { createAgentsVitestConfig } from "../vitest/vitest.agents.config.ts";
import { cliProcessTestFiles } from "../vitest/vitest.cli-process-paths.mjs";
import { createCliProcessVitestConfig } from "../vitest/vitest.cli-process.config.ts";
import { createCommandsVitestConfig } from "../vitest/vitest.commands.config.ts";
import { databaseWorkerCoreTestFiles } from "../vitest/vitest.database-worker-core-paths.mjs";
import { diagnosticForksPool } from "../vitest/vitest.forks-pool.ts";
import { createGatewayClientVitestConfig } from "../vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "../vitest/vitest.gateway-core.config.ts";
import { createGatewayDatabaseWorkersVitestConfig } from "../vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "../vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "../vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "../vitest/vitest.gateway-server-isolated.config.ts";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayServerIsolatedTestFiles,
  gatewayServerSerialTestFiles,
  isGatewayServerTestFile,
} from "../vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "../vitest/vitest.gateway-server.config.ts";
import { createInfraVitestConfig } from "../vitest/vitest.infra.config.ts";
import { createMediaUnderstandingVitestConfig } from "../vitest/vitest.media-understanding.config.ts";
import { createMediaVitestConfig } from "../vitest/vitest.media.config.ts";
import { createPluginSdkLightVitestConfig } from "../vitest/vitest.plugin-sdk-light.config.ts";
import { createPluginSdkVitestConfig } from "../vitest/vitest.plugin-sdk.config.ts";
import { createPluginsVitestConfig } from "../vitest/vitest.plugins.config.ts";
import { createRuntimeConfigVitestConfig } from "../vitest/vitest.runtime-config.config.ts";
import { sharedVitestConfig } from "../vitest/vitest.shared.config.ts";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import { createTasksVitestConfig } from "../vitest/vitest.tasks.config.ts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import { createToolingVitestConfig } from "../vitest/vitest.tooling.config.ts";
import { createTuiVitestConfig } from "../vitest/vitest.tui.config.ts";
import { createUiIsolatedVitestConfig } from "../vitest/vitest.ui-isolated.config.ts";
import { uiTimingTestFiles } from "../vitest/vitest.ui-paths.mjs";
import { createUiTimingVitestConfig } from "../vitest/vitest.ui-timing.config.ts";
import { createUiVitestConfig } from "../vitest/vitest.ui.config.ts";
import {
  getUnitFastTestFilesForIncludePatterns,
  getUnitFastIsolatedTestFiles,
  getUnitFastTimerTestFiles,
} from "../vitest/vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "../vitest/vitest.unit-fast.config.ts";
import { createUnitVitestConfigWithOptions } from "../vitest/vitest.unit.config.ts";
import { createWizardVitestConfig } from "../vitest/vitest.wizard.config.ts";
import { listMatchedTestFiles, listTestFiles } from "./ci-node-test-plan.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Control UI release-only inventories", () => {
  const sidebar = "ui/src/components/app-sidebar.stress.browser.test.ts";
  const embed = "ui/src/e2e/native-embed-settings.e2e.test.ts";
  const entry = "ui/src/e2e/chat-session-entry.e2e.test.ts";

  it("omits only the named exhaustive matrices from ordinary UI owners", () => {
    const groups = createUiTestShardGroups({ includeReleaseOnlyTests: false });
    expect(groups.ui[0]?.includePatterns).not.toContain(sidebar);
    expect(groups.e2e[0]?.includePatterns).not.toContain(embed);
    expect(groups.e2e[0]?.includePatterns).not.toContain(entry);
    expect(groups.ui[0]?.includePatterns).toContain(
      "ui/src/components/app-sidebar-row-identity.browser.test.ts",
    );
    expect(groups.e2e[0]?.includePatterns).toContain(
      "ui/src/e2e/chat-flow.navigation-presentation.e2e.test.ts",
    );
    expect(groups.ui[0]?.includePatterns?.some((file) => file.endsWith(".e2e.test.ts"))).toBe(
      false,
    );
  });

  it("retains directly edited matrices without widening from their source owner", () => {
    const groups = createUiTestShardGroups({
      includeReleaseOnlyTests: false,
      changedPaths: [entry, "ui/src/components/app-sidebar.ts", "ui/src/e2e"],
    });
    expect(groups.e2e[0]?.includePatterns).toContain(entry);
    expect(groups.e2e[0]?.includePatterns).not.toContain(embed);
    expect(groups.ui[0]?.includePatterns).not.toContain(sidebar);
  });

  it("leaves the complete canonical config inventories in full release validation", () => {
    expect(createUiTestShardGroups()).toEqual({
      ui: [{ configs: ["ui/vitest.config.ts"], shard_name: "ui/vitest.config.ts" }],
      e2e: [
        {
          configs: ["test/vitest/vitest.ui-e2e.config.ts"],
          shard_name: "test/vitest/vitest.ui-e2e.config.ts",
        },
      ],
    });
  });
});

describe("startup corpus coverage", () => {
  const files = startupCorpusTestFiles;
  const group = {
    shard_name: "core-runtime-config",
    configs: ["test/vitest/vitest.runtime-config.config.ts"],
    requiresDist: false,
    runner: "ubuntu-24.04",
    includePatterns: files,
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
  };
  it("retains complete ownership across separate file groups", () => {
    const groups = files.map((file) => ({ ...group, includePatterns: [file] }));
    expect(hasCompleteStartupCorpusCoverage([{ requiresDist: false, groups }])).toBe(true);
    expect(listMatchedTestFiles(createRuntimeConfigVitestConfig({}))).toEqual(
      expect.arrayContaining(files),
    );
  });
  it.each<
    { label: string } & Partial<Parameters<typeof hasCompleteStartupCorpusCoverage>[0][number]>
  >([
    ...files.map((missingFile) => ({
      label: `missing ${missingFile}`,
      groups: [{ ...group, includePatterns: files.filter((file) => file !== missingFile) }],
    })),
    { label: "unknown full config", groups: [{ ...group, includePatterns: undefined }] },
    {
      label: "glob instead of complete files",
      groups: [{ ...group, includePatterns: ["src/config/**"] }],
    },
    { label: "different config", groups: [{ ...group, configs: ["vitest.config.ts"] }] },
    {
      label: "native shard",
      groups: [{ ...group, env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]' } }],
    },
    {
      label: "name filter",
      groups: [{ ...group, env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["-t","one"]' } }],
    },
    { label: "target precedence", groups: [group], targets: files.slice(0, 1) },
    { label: "non-admitted dist row", groups: [group], requiresDist: true },
    { label: "no groups", groups: [] },
  ])("does not certify $label", ({ label: _label, ...shard }) => {
    expect(hasCompleteStartupCorpusCoverage([{ requiresDist: false, ...shard }])).toBe(false);
  });
});

const PLUGIN_PRERELEASE_NPM_SPEC_TEST = "src/plugins/install.npm-spec.test.ts";
const RELEASE_REPORT_OWNER_TEST = "test/scripts/vitest-report-owner.test.ts";
const PRIVATE_QA_TOOLING_TEST = "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts";
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
const fileParallelAgentGroupNames = new Set([
  "agentic-agents-embedded-base-1",
  "agentic-agents-embedded-base-2",
  "agentic-agents-embedded-base-3",
  "agentic-agents-embedded-run",
  "agentic-agents-tools",
]);
const plannerHosts = [
  { label: "hosted-2cpu", logicalCpuCount: 2, totalMemoryBytes: 16 * 1024 ** 3 },
  { label: "large-32cpu", logicalCpuCount: 32, totalMemoryBytes: 512 * 1024 ** 3 },
] as const;
type PlannerHost = (typeof plannerHosts)[number];
function usesParallelPacking(job: CompactNodeTestShard | undefined) {
  return (
    job?.planConcurrency === 2 ||
    job?.env?.OPENCLAW_VITEST_MAX_WORKERS === "2" ||
    (job?.planConcurrency === 1 &&
      job.runner === EXTRA_LARGE_NODE_TEST_RUNNER &&
      job.groups.length > 1 &&
      job.groups.some(
        (group) =>
          (group.fallbackMaxWorkers === 2 &&
            (group.configs.some(isExclusiveCiTestConfig) ||
              fileParallelAgentGroupNames.has(group.shard_name.replace(/-hosted-\d+$/u, "")))) ||
          group.configs.includes("test/vitest/vitest.commands.config.ts"),
      ))
  );
}
function isNumberedToolingGroup(group: { shard_name: string }) {
  return /^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name);
}
function nonToolingPlacement(plan: CompactNodeTestShard[]) {
  return plan
    .flatMap((job) => {
      const groups = job.groups
        .filter((group) => !isNumberedToolingGroup(group))
        .map((group) => group.shard_name)
        .toSorted();
      return groups.length === 0
        ? []
        : [
            {
              groups,
              planConcurrency: job.planConcurrency,
              pretestBuildMode: job.pretestBuildMode,
              requiresDist: job.requiresDist,
              runner: job.runner,
            },
          ];
    })
    .toSorted((a, b) => a.groups.join("\0").localeCompare(b.groups.join("\0")));
}
function isCombinedUnbuiltCliJob(job: CompactNodeTestShard) {
  return (
    job.groups.length > 1 &&
    !job.requiresDist &&
    !job.pretestBuildMode &&
    job.groups.every((group) =>
      group.configs.every((config) =>
        ["test/vitest/vitest.cli.config.ts", "test/vitest/vitest.cli-process.config.ts"].includes(
          config,
        ),
      ),
    )
  );
}
const STORE_ALIAS_CHANGED_PATHS = [
  "docs/gateway/secrets.md",
  "src/agents/auth-profiles/read-only-availability.test.ts",
  "src/agents/auth-profiles/read-only-availability.ts",
  "src/agents/model-auth-availability.test.ts",
  "src/plugins/manifest-tool-availability.test.ts",
  "src/plugins/manifest-tool-availability.ts",
  "src/plugins/tools.optional.test.ts",
];
function listAllToolingTestFiles(): string[] {
  const originalArgv = process.argv;
  try {
    process.argv = originalArgv.slice(0, 2);
    return listMatchedTestFiles(
      createToolingVitestConfig({
        ...process.env,
        OPENCLAW_VITEST_INCLUDE_FILE: undefined,
      }),
    );
  } finally {
    process.argv = originalArgv;
  }
}

describe("scripts/lib/ci-node-test-plan.mts", () => {
  it("packs ordinary work more densely while retaining the serial Gateway budget", () => {
    vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({
      "agentic-gateway-server-isolated": 200,
      "agentic-agents-core-models": 160,
      "agentic-agents-core-runtime": 160,
      "ordinary-a": 150,
      "ordinary-b": 150,
      "ordinary-c": 150,
      "ordinary-d": 150,
      "agentic-agents-core-auth": 150,
      "agentic-agents-core-tools": 150,
    });
    vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
    vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
    const original = fullSuiteVitestShards.slice();
    try {
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...[
          ["agentic-gateway-server-isolated", "gateway-server-isolated"],
          ["agentic-agents-core-models", "unit-support"],
          ["agentic-agents-core-runtime", "unit-fast-isolated"],
          ["ordinary-a", "hooks"],
          ["ordinary-b", "secrets"],
          ["ordinary-c", "logging"],
          ["ordinary-d", "unit-support"],
          ["agentic-agents-core-auth", "hooks"],
          ["agentic-agents-core-tools", "secrets"],
        ].map(([name, config]) => ({
          name: name!,
          config: `fixture-${name}.config.ts`,
          projects: [`test/vitest/vitest.${config}.config.ts`],
        })),
      );
      const jobs = createNodeTestShardBundles({
        compactMode: "push",
        runnerBackend: "blacksmith",
        includeReleaseOnlyPluginShards: false,
      });
      const gateway = expectDefined(
        jobs.find((job) =>
          job.groups.some((group) =>
            group.configs.includes("test/vitest/vitest.gateway-server-isolated.config.ts"),
          ),
        ),
        "Gateway job",
      );
      expect(gateway.planConcurrency).toBe(1);
      expect(gateway.groups.map((group) => group.shard_name).toSorted()).toEqual([
        "agentic-agents-core-models",
        "agentic-gateway-server-isolated",
      ]);
      expect(gateway.env).toBeUndefined();
      expect(
        gateway.groups
          .map((group): [string, string | undefined] => [
            group.shard_name,
            group.env?.OPENCLAW_VITEST_MAX_WORKERS,
          ])
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        ["agentic-agents-core-models", "2"],
        ["agentic-gateway-server-isolated", "8"],
      ]);
      expect(gateway.predictedSeconds).toBe(360);
      const ordinary = expectDefined(
        jobs.find((job) => job.groups.some((group) => group.shard_name === "ordinary-a")),
        "ordinary job",
      );
      expect(ordinary.planConcurrency).toBe(2);
      expect(ordinary.groups.map((group) => group.shard_name).toSorted()).toEqual([
        "agentic-agents-core-auth",
        "agentic-agents-core-runtime",
        "ordinary-a",
      ]);
      expect(new Set(ordinary.groups.map((group) => group.runner))).toEqual(
        new Set([BUNDLED_NODE_TEST_RUNNER, DEFAULT_NODE_TEST_RUNNER]),
      );
      expect(ordinary.predictedSeconds).toBe(460);
      expect(
        jobs.find((job) => job.groups.some((group) => group.shard_name === "ordinary-d")),
      ).toMatchObject({
        planConcurrency: 2,
        runner: EXTRA_LARGE_NODE_TEST_RUNNER,
        predictedSeconds: 450,
      });
      expect(jobs).toHaveLength(4);
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
    }
  });

  it("retains the two-worker ceiling when compaction leaves a singleton", () => {
    const entries = [
      ["core-runtime-media-ui-11", 200],
      ["agentic-agents-embedded-base-11", 180],
      ["core-unit-src-security-11", 180],
      ["agentic-agents-embedded-base-12", 170],
      ["core-runtime-media-ui-12", 170],
      ["agentic-agents-embedded-base-13", 160],
      ["core-unit-src-security-12", 160],
      ["agentic-agents-embedded-base-14", 110],
      ["core-runtime-media-ui-13", 110],
      ["core-unit-src-security-13", 50],
    ] as const;
    // These synthetic costs already describe parallel embedded invocations.
    vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(
      Object.fromEntries(
        entries.map(([name, seconds]) => [
          name.startsWith("agentic-agents-embedded-base-") ? `${name}#file-parallel` : name,
          seconds,
        ]),
      ),
    );
    vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
    vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
    const original = fullSuiteVitestShards.slice();
    try {
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...entries.map(([name]) => ({
          name,
          config: `fixture-${name}.config.ts`,
          projects: ["test/vitest/vitest.hooks.config.ts"],
        })),
      );
      const jobs = createNodeTestShardBundles({
        compactMode: "push",
        runnerBackend: "blacksmith",
        includeReleaseOnlyPluginShards: false,
      });
      expect(jobs).toHaveLength(4);
      const singleton = jobs.find((job) => job.groups.length === 1);
      expect(singleton).toMatchObject({
        runner: EXTRA_LARGE_NODE_TEST_RUNNER,
        planConcurrency: 1,
        predictedSeconds: 110,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      });
      expect(singleton?.groups[0]?.shard_name).toBe("agentic-agents-embedded-base-14");
      expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual(
        entries.map(([name]) => name).toSorted(),
      );
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
    }
  });

  it("freezes settled serial Gateway rows when compacting neighboring parallel jobs", () => {
    const entries = [
      ["agentic-agents-core-auth", "unit-support", 200],
      ["agentic-agents-core-models", "hooks", 160],
      ["agentic-agents-core-runtime", "secrets", 140],
      ["agentic-gateway-server-isolated", "gateway-server-isolated", 130],
      ["agentic-agents-core-subagents", "logging", 90],
      ["agentic-agents-core-tools", "unit-fast-isolated", 80],
      ["agentic-agents-core-runner-commands", "unit-support", 80],
      ["agentic-agents-core-runner-embedded", "hooks", 80],
      ["agentic-agents-core-runner-sessions", "secrets", 80],
      ["core-unit-fast-1", "logging", 80],
      ["core-unit-fast-2", "unit-fast-isolated", 80],
    ] as const;
    vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(
      Object.fromEntries(entries.map(([name, , seconds]) => [name, seconds])),
    );
    vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
    vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
    const original = fullSuiteVitestShards.slice();
    try {
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...entries.map(([name, config]) => ({
          name,
          config: `fixture-${name}.config.ts`,
          projects: [`test/vitest/vitest.${config}.config.ts`],
        })),
      );
      const jobs = createNodeTestShardBundles({
        compactMode: "push",
        runnerBackend: "blacksmith",
        includeReleaseOnlyPluginShards: false,
      });
      const gateway = jobs.find((job) =>
        job.groups.some((group) => group.shard_name === "agentic-gateway-server-isolated"),
      );
      expect(gateway).toMatchObject({
        checkName: "checks-node-compact-large-2",
        shardName: "compact-large-2",
        runner: EXTRA_LARGE_NODE_TEST_RUNNER,
        planConcurrency: 1,
        predictedSeconds: 360,
        env: undefined,
      });
      expect(gateway?.groups.map((group) => group.shard_name)).toEqual([
        "agentic-agents-core-runtime",
        "agentic-gateway-server-isolated",
        "agentic-agents-core-subagents",
      ]);
      expect(gateway?.groups.map((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS)).toEqual([
        "2",
        "8",
        "2",
      ]);
      expect(jobs.filter((job) => job !== gateway).map((job) => job.predictedSeconds)).toEqual([
        440, 400,
      ]);
      expect(jobs).toHaveLength(3);
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
    }
  });

  // Read-only cases share this baseline; inventory and timing mutations build fresh plans.
  let defaultShards: ReturnType<typeof createNodeTestShards>;

  // Only unchanged committed inputs share snapshots; every caller receives its own graph.
  const committedCompactPlans = new Map<string, CompactNodeTestShard[]>();
  let plannerHostPinned = false;
  function pinPlannerHost(host: PlannerHost) {
    plannerHostPinned = true;
    committedCompactPlans.clear();
    vi.spyOn(os, "availableParallelism").mockReturnValue(host.logicalCpuCount);
    vi.spyOn(os, "cpus").mockReturnValue(
      Array.from({ length: host.logicalCpuCount }, () => ({
        model: "fixture",
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      })),
    );
    vi.spyOn(os, "totalmem").mockReturnValue(host.totalMemoryBytes);
    syncBuiltinESMExports();
    vi.stubEnv("CI", "true");
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "1");
    expect(Object.keys(testTimings.readCompactGroupTimings("blacksmith")).length).toBeGreaterThan(
      0,
    );
    expect(testTimings.readRuntimePlacementTimings("blacksmith").length).toBeGreaterThan(0);
  }
  function getCommittedCompactPlan(
    compactMode: "push" | "pull-request",
    runnerBackend?: string,
  ): CompactNodeTestShard[] {
    const key = JSON.stringify([compactMode, runnerBackend]);
    let snapshot = committedCompactPlans.get(key);
    if (!snapshot) {
      snapshot = structuredClone(
        createNodeTestShardBundles({
          includeReleaseOnlyPluginShards: false,
          compactMode,
          ...(runnerBackend === undefined ? {} : { runnerBackend }),
        }),
      );
      committedCompactPlans.set(key, snapshot);
    }
    return structuredClone(snapshot);
  }

  beforeAll(() => {
    defaultShards = createNodeTestShards();
  });

  it("discovers only tooling files for a cold precise tooling plan", () => {
    const result = spawnNodeEvalSync(`
      import fs from "node:fs";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      let sourceReads = 0;
      const readFileSync = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        const relative = path.relative(process.cwd(), String(file)).replaceAll("\\\\", "/");
        if (relative.startsWith("src/") && relative.endsWith(".test.ts")) sourceReads += 1;
        return readFileSync.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      const { createChangedNodeTestShards } = await import("./scripts/lib/ci-changed-node-test-plan.mts");
      const importReads = sourceReads;
      const target = "test/scripts/managed-child-process.test.ts";
      const plan = createChangedNodeTestShards([target], { runnerBackend: "github" });
      console.log(JSON.stringify({
        importReads,
        sourceReads,
        distOwners: plan?.filter((shard) => shard.requiresDist).map((shard) => shard.groups.flatMap((group) => group.configs)).flat().sort(),
        selected: plan?.filter((shard) => !shard.requiresDist).flatMap((shard) => shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? []).sort(),
      }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      importReads: 0,
      sourceReads: 0,
      distOwners: ["test/vitest/vitest.boundary.config.ts", "test/vitest/vitest.tui-pty.config.ts"],
      selected: [
        "test/scripts/managed-child-process.test.ts",
        "test/scripts/test-projects.test.ts",
      ],
    });
  });

  it.each([
    { runnerBackend: "blacksmith", serialEstimate: 60, parallelEstimate: 24 },
    { runnerBackend: "blacksmith", serialEstimate: 53, parallelEstimate: 24, indivisible: true },
    { runnerBackend: "hybrid", serialEstimate: 52, parallelEstimate: 21 },
    { runnerBackend: "github", serialEstimate: 80, parallelEstimate: 24 },
  ])(
    "prices parallel agent files once across $runnerBackend timing refits ($serialEstimate s fallback)",
    ({ runnerBackend, serialEstimate, parallelEstimate, indivisible = false }) => {
      const originalShards = fullSuiteVitestShards.slice();
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...originalShards
          .map((shard) => ({
            ...shard,
            projects: shard.projects.filter((config) =>
              indivisible
                ? embeddedAgentVitestProjectOwners.some((owner) => owner.config === config)
                : config === agentVitestProjectOwners.tools.config,
            ),
          }))
          .filter((shard) => shard.projects.length > 0),
      );
      try {
        const owner = "agentic-agents-tools";
        const timings: Record<"blacksmith" | "github", Record<string, number>> = {
          blacksmith: indivisible
            ? {
                "agentic-agents-embedded-base-1": 66,
                "agentic-agents-embedded-base-2": 66,
                "agentic-agents-embedded-base-3": 66,
                // Keep non-base owners out of the indivisible file's admission row.
                "agentic-agents-embedded-incomplete-turn": 1_000,
                "agentic-agents-embedded-overflow-compaction": 1_000,
                "agentic-agents-embedded-run": 2_000,
              }
            : { [owner]: 120 },
          github: { [owner]: 160 },
        };
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation(
          (profile) => timings[profile],
        );
        vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
        const options = { compactMode: "push" as const, runnerBackend };
        const selectOwnerJob = (plan: CompactNodeTestShard[]) =>
          expectDefined(
            plan.find((job) =>
              job.groups.some((group) =>
                indivisible
                  ? group.includePatterns?.includes(
                      "src/agents/embedded-agent-runner/run.compaction-runtime.test.ts",
                    )
                  : group.shard_name === owner,
              ),
            ),
            "priced agent owner",
          );
        const initial = selectOwnerJob(createNodeTestShardBundles(options));
        expect(initial.predictedSeconds).toBe(serialEstimate);
        expect(initial.groups).toHaveLength(1);
        const group = initial.groups[0]!;
        const key = expectDefined(group.timing_key, "parallel timing identity");
        expect(key).toBe(`${group.shard_name}#file-parallel`);
        timings.blacksmith[key] = 24;
        timings.github[key] = 24;
        const refitted = selectOwnerJob(createNodeTestShardBundles(options));
        // New wall samples override serial/file floors and must not be divided again.
        expect(refitted.predictedSeconds).toBe(parallelEstimate);
        expect(refitted.groups).toEqual(initial.groups);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );

  it("binds split timing identity to exact complete-file membership", () => {
    const common = {
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      env: { OPENCLAW_GATEWAY_TEST_WORKERS: "2" },
      parentShardName: "agentic-control-plane-agent-chat",
    };
    const original = createCompactSplitTimingGeneration({
      ...common,
      stripes: [["src/gateway/a.test.ts"], ["src/gateway/b.test.ts"]],
    });
    expect(
      createCompactSplitTimingGeneration({
        ...common,
        stripes: [["src/gateway/a.test.ts"], ["src/gateway/b.test.ts"]],
      }),
    ).toEqual(original);
    expect(
      createCompactSplitTimingGeneration({
        ...common,
        stripes: [["src/gateway/a.test.ts"], ["src/gateway/c.test.ts"]],
      }),
    ).not.toEqual(original);
    expect(
      createCompactSplitTimingGeneration({
        ...common,
        stripes: [["src/gateway/b.test.ts"], ["src/gateway/a.test.ts"]],
      }),
    ).not.toEqual(original);
  });

  it.each(["blacksmith", "hybrid", "github"])(
    "prices agents-core serial history with two file workers on %s without discounting parallel samples",
    async (runnerBackend) => {
      const config = agentVitestProjectOwners.core.config;
      const models = "agentic-agents-core-models";
      const singleton = "agentic-agents-core-auth";
      const commands = "agentic-agents-core-runner-commands";
      const heavyModel = "src/agents/model-heavy.test.ts";
      const fastModel = "src/agents/model-fast.test.ts";
      const e2eModel = "src/agents/model-fixture.e2e.test.ts";
      const runtimeFile = "src/agents/agent-command-runtime.test.ts";
      const commandPeers = [
        "src/agents/agent-command-a.test.ts",
        "src/agents/agent-command-b.test.ts",
      ];
      const files = [
        heavyModel,
        "src/agents/model-light.test.ts",
        fastModel,
        e2eModel,
        "src/agents/auth-fixture.test.ts",
        runtimeFile,
        ...commandPeers,
      ].toSorted();
      const seconds: Record<string, number> = { [models]: 200, [singleton]: 40, [commands]: 0 };
      const fileWeights = vi.fn((_file: string) => 1);
      const buildMode = vi.fn<typeof buildPrerequisites.resolveVitestPretestBuildMode>(
        () => undefined,
      );
      const unitFastPaths = await vi.importActual<
        typeof import("../vitest/vitest.unit-fast-paths.mjs")
      >("../vitest/vitest.unit-fast-paths.mjs");
      vi.resetModules();
      vi.doMock("../vitest/vitest.unit-fast-paths.mjs", () => ({
        ...unitFastPaths,
        getUnitFastTestFiles: () => [fastModel],
        getUnitFastIsolatedTestFiles: () => [],
        getUnitFastTimerTestFiles: () => [],
        getUnitFastTestFilesForIncludePatterns: () => [fastModel],
      }));
      vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
        fullSuiteVitestShards: [
          {
            config: "test/vitest/vitest.full-agentic.config.ts",
            name: "agentic",
            projects: [config],
          },
        ],
      }));
      vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
        listTrackedTestFiles: (root: string) => (root === "src/agents" ? files : []),
      }));
      vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
        ...testTimings,
        readCompactGroupTimings: () => seconds,
        readRuntimePlacementTimings: () => [],
      }));
      vi.doMock("../../scripts/lib/vitest-shard-metadata.mts", () => ({
        ...shardMetadata,
        estimateVitestTestFileSeconds: fileWeights,
      }));
      vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", () => ({
        ...buildPrerequisites,
        resolveVitestPretestBuildMode: buildMode,
        listVitestRuntimeConsumerFiles: () => [runtimeFile],
      }));
      try {
        const { createNodeTestShardBundles: createPlan } =
          await import("../../scripts/lib/ci-node-test-plan.mts");
        const options = {
          compactMode: "push" as const,
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
        };
        const predicted = (jobs: CompactNodeTestShard[]) =>
          jobs.reduce((sum, job) => sum + (job.predictedSeconds ?? 0), 0);
        const baseline = createPlan(options);
        // The authentication fixture is indivisible; only the two models share work.
        expect(predicted(baseline)).toBe(runnerBackend === "hybrid" ? 122 : 140);
        expect(
          baseline
            .flatMap((job) => job.groups)
            .every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2"),
        ).toBe(true);
        for (const excluded of [e2eModel, fastModel]) {
          fileWeights.mockImplementation((file) => (file === excluded ? 1_000_000 : 1));
          expect(predicted(createPlan(options))).toBe(predicted(baseline));
        }
        // One model owns 75% of the serial work; two workers cannot halve it.
        fileWeights.mockImplementation((file) => (file === heavyModel ? 3 : 1));
        expect(predicted(createPlan(options))).toBe(runnerBackend === "hybrid" ? 166 : 190);
        fileWeights.mockReturnValue(1);
        seconds[`${models}-parallel`] = 200;
        const measured = createPlan(options);
        // Hosted splitting turns two concurrent 200s files into two 200s children.
        expect(predicted(measured)).toBe(
          runnerBackend === "blacksmith" ? 240 : runnerBackend === "hybrid" ? 383 : 440,
        );
        expect(
          measured
            .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
            .toSorted(),
        ).toEqual(files);
        expect(
          measured
            .flatMap((job) => job.groups)
            .filter((group) => group.shard_name.startsWith(models))
            .every((group) => group.timing_key?.startsWith(`${models}-parallel`)),
        ).toBe(true);
        if (runnerBackend !== "blacksmith") {
          const modelGroups = measured
            .flatMap((job) => job.groups)
            .filter((group) => group.shard_name.startsWith(models));
          expect(modelGroups).toHaveLength(2);
          expect(
            modelGroups.map(
              (group) =>
                group.includePatterns?.filter((file) => file !== e2eModel && file !== fastModel)
                  .length,
            ),
          ).toEqual([1, 1]);
          modelGroups.forEach((group, index) => {
            seconds[group.timing_key!] = index === 0 ? 180 : 190;
          });
          const childMeasured = createPlan(options);
          expect(predicted(childMeasured)).toBe(runnerBackend === "hybrid" ? 357 : 410);
          expect(
            childMeasured
              .flatMap((job) => job.groups)
              .filter((group) => group.shard_name.startsWith(models))
              .map((group) => expectDefined(group.timing_key, "parallel model timing key"))
              .toSorted(),
          ).toEqual(
            modelGroups
              .map((group) => expectDefined(group.timing_key, "parallel model timing key"))
              .toSorted(),
          );
          for (const group of modelGroups) {
            delete seconds[group.timing_key!];
          }
        }

        seconds[models] = 0;
        seconds[`${models}-parallel`] = 0;
        seconds[singleton] = 0;
        seconds[commands] = 74;
        const legacy = createCompactSplitTimingGeneration({
          configs: [config],
          parentShardName: commands,
          stripes: [[runtimeFile], [commandPeers[0]!], [commandPeers[1]!]],
        });
        Object.assign(
          seconds,
          Object.fromEntries(legacy.timingKeys.map((key, index) => [key, index === 0 ? 28 : 23])),
        );
        fileWeights.mockImplementation((file) => (commandPeers.includes(file) ? 4 : 1));
        buildMode.mockImplementation((plans) =>
          plans.some((plan) => plan.matchesFile?.(runtimeFile, false, plan.includePatterns))
            ? "runtime"
            : undefined,
        );
        const migrated = createPlan(options);
        const runtimeJob = migrated.find((job) =>
          job.groups.some((group) => group.includePatterns?.includes(runtimeFile)),
        );
        // Merging the two sibling stripes preserves the singleton's 28s measurement.
        expect(runtimeJob?.predictedSeconds).toBe(
          runnerBackend === "github" ? 188 : runnerBackend === "hybrid" ? 125 : 128,
        );
        seconds[`${commands}-parallel`] = 200;
        const projectedRuntimeJob = createPlan(options).find((job) =>
          job.groups.some((group) => group.includePatterns?.includes(runtimeFile)),
        );
        expect(projectedRuntimeJob?.predictedSeconds).toBe(
          runnerBackend === "github" ? 205 : runnerBackend === "hybrid" ? 139 : 145,
        );
        const runtimeGroup = projectedRuntimeJob!.groups.find((group) =>
          group.includePatterns?.includes(runtimeFile),
        )!;
        expect(runtimeGroup.includePatterns).toEqual([runtimeFile]);
        seconds[runtimeGroup.timing_key!] = 10;
        const refitted = createPlan(options).find((job) =>
          job.groups.some((group) => group.includePatterns?.includes(runtimeFile)),
        );
        // An exact parallel sample replaces the migrated serial observation.
        expect(refitted?.predictedSeconds).toBe(
          runnerBackend === "github" ? 170 : runnerBackend === "hybrid" ? 109 : 110,
        );
      } finally {
        vi.doUnmock("../../scripts/lib/vitest-build-prerequisites.mts");
        vi.doUnmock("../../scripts/lib/vitest-shard-metadata.mts");
        vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
        vi.doUnmock("../../scripts/lib/list-test-files.mts");
        vi.doUnmock("../vitest/vitest.test-shards.mjs");
        vi.doUnmock("../vitest/vitest.unit-fast-paths.mjs");
        vi.resetModules();
      }
    },
  );

  it("retains isolated Gateway timing history recorded under its former job cap", () => {
    const owner = "agentic-gateway-server-isolated";
    const configs = [
      "test/vitest/vitest.gateway-server-isolated.config.ts",
      "test/vitest/vitest.gateway-database-workers.config.ts",
    ];
    const originalShards = fullSuiteVitestShards.slice();
    const fixtureShards = originalShards
      .map((shard) => ({
        ...shard,
        projects: shard.projects.filter((config) => configs.includes(config)),
      }))
      .filter((shard) => shard.projects.length > 0);
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
    try {
      const previous: Record<string, number> = { [owner]: 100 };
      vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) =>
        profile === "blacksmith" ? previous : { [owner]: 100 },
      );
      const options = { compactMode: "push" as const, runnerBackend: "hybrid" };
      const initial = createNodeTestShardBundles(options).flatMap((job) => job.groups);
      expect(initial).toHaveLength(2);
      const legacy = createCompactSplitTimingGeneration({
        configs,
        parentShardName: owner,
        stripes: initial.map((group) => group.includePatterns!),
      });
      for (const [index, key] of legacy.timingKeys.entries()) {
        previous[key] = 247 + index;
      }
      const expanded = createNodeTestShardBundles(options);
      expect(
        expanded.reduce(
          (sum, job) => sum + expectDefined(job.predictedSeconds, "compact job prediction"),
          0,
        ),
      ).toBeGreaterThanOrEqual(495);
      expect(
        expanded.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!)).toSorted(),
      ).toEqual(initial.flatMap((group) => group.includePatterns!).toSorted());
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
    }
  });

  it.each([
    {
      owner: "agentic-agents-support",
      config: agentVitestProjectOwners.support.config,
      previousWorkers: undefined,
    },
    {
      owner: "agentic-gateway-core-2",
      config: "test/vitest/vitest.gateway-core.config.ts",
      previousWorkers: "2",
    },
  ])(
    "retains complete $owner timing floors and ignores partial generations",
    ({ owner, config, previousWorkers }) => {
      const originalShards = fullSuiteVitestShards.slice();
      const fixtureShards = originalShards
        .map((shard) => ({
          ...shard,
          projects: shard.projects.filter((candidate) => candidate === config),
        }))
        .filter((shard) => shard.projects.length > 0);
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
      try {
        let overlays: Record<"blacksmith" | "github", Readonly<Record<string, number>>> = {
          blacksmith: { [owner]: 165 },
          github: { [owner]: 253 },
        };
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation(
          (profile) => overlays[profile],
        );
        const options = {
          compactMode: "pull-request" as const,
          includeReleaseOnlyPluginShards: false,
          runnerBackend: "hybrid",
        };
        const initialPlan = createNodeTestShardBundles(options);
        const ownerGroups = (plan: typeof initialPlan) =>
          plan
            .flatMap((job) => job.groups)
            .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner)
            .toSorted((left, right) => left.shard_name.localeCompare(right.shard_name));
        const initial = ownerGroups(initialPlan);
        expect(initial).toHaveLength(2);
        const originalFiles = initial.flatMap((group) => group.includePatterns!).toSorted();
        const previousGeneration = createCompactSplitTimingGeneration({
          configs: initial[0]!.configs,
          env: previousWorkers
            ? { ...initial[0]!.env, OPENCLAW_VITEST_MAX_WORKERS: previousWorkers }
            : initial[0]!.env,
          parentShardName: owner,
          stripes: initial.map((group) => group.includePatterns!),
        });
        overlays.blacksmith = {
          ...overlays.blacksmith,
          ...Object.fromEntries(
            previousGeneration.timingKeys.map((key, index) => [key, 247 + index]),
          ),
        };

        const expanded = ownerGroups(createNodeTestShardBundles(options));
        expect(expanded).toHaveLength(4);
        expect(expanded.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
          originalFiles,
        );
        expect(
          expanded.every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined),
        ).toBe(true);
        const stripes = expanded.map((group) => group.includePatterns!);
        const changedStripesA = stripes.map((patterns) => patterns.slice());
        const first = changedStripesA[0]!.shift()!;
        const second = changedStripesA[1]!.shift()!;
        changedStripesA[0]!.push(second);
        changedStripesA[1]!.push(first);
        const partialA = createCompactSplitTimingGeneration({
          configs: expanded[0]!.configs,
          env: expanded[0]!.env,
          parentShardName: owner,
          stripes: changedStripesA,
        });
        const changedStripesB = stripes.map((patterns) => patterns.slice());
        const third = changedStripesB[2]!.shift()!;
        const fourth = changedStripesB[3]!.shift()!;
        changedStripesB[2]!.push(fourth);
        changedStripesB[3]!.push(third);
        const partialB = createCompactSplitTimingGeneration({
          configs: expanded[0]!.configs,
          env: expanded[0]!.env,
          parentShardName: owner,
          stripes: changedStripesB,
        });
        overlays = {
          github: { [owner]: 100 },
          blacksmith: {
            [owner]: 100,
            [partialA.timingKeys[0]!]: 1_000,
            [partialA.timingKeys[1]!]: 1_000,
            [partialB.timingKeys[2]!]: 1_000,
            [partialB.timingKeys[3]!]: 1_000,
          },
        };
        const incomplete = createNodeTestShardBundles(options).flatMap((job) => job.groups);
        expect(incomplete.filter((group) => group.shard_name === owner)).toHaveLength(1);
        expect(
          incomplete.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)),
        ).toHaveLength(0);

        overlays.blacksmith = {
          ...overlays.blacksmith,
          ...Object.fromEntries(expanded.map((group) => [group.timing_key!, 124])),
        };

        const stable = ownerGroups(createNodeTestShardBundles(options));
        expect(stable).toHaveLength(4);
        expect(stable.map((group) => group.timing_key)).toEqual(
          expanded.map((group) => group.timing_key),
        );
        expect(stable.flatMap((group) => group.includePatterns!).toSorted()).toEqual(originalFiles);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );

  it.each([
    { profile: "blacksmith", owner: "auto-reply-reply-state-routing", fallback: 60, measured: 99 },
    { profile: "hybrid", owner: "auto-reply-reply-state-routing", fallback: 52, measured: 86 },
    { profile: "github", owner: "auto-reply-reply-state-routing", fallback: 60, measured: 99 },
    { profile: "blacksmith", owner: "auto-reply-reply-dispatch-core", fallback: 120, measured: 99 },
  ])(
    "prices $owner on $profile at two workers without discounting new measurements",
    ({ profile, owner, fallback, measured }) => {
      const original = fullSuiteVitestShards.slice();
      const config = "test/vitest/vitest.auto-reply-reply.config.ts";
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...original
          .map((shard) => ({
            ...shard,
            projects: shard.projects.filter((candidate) => candidate === config),
          }))
          .filter((shard) => shard.projects.length > 0),
      );
      try {
        const owners = createNodeTestShards();
        const timings = Object.fromEntries(owners.map((shard) => [shard.shardName, 0]));
        timings[owner] = 120;
        vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
        const options = {
          includeReleaseOnlyPluginShards: false,
          compactMode: "pull-request" as const,
          runnerBackend: profile,
        };
        const before = createNodeTestShardBundles(options);
        expect(
          before.reduce(
            (sum, job) => sum + expectDefined(job.predictedSeconds, "predicted compact seconds"),
            0,
          ),
        ).toBe(fallback);
        expect(
          before
            .flatMap((job) => job.groups)
            .every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2"),
        ).toBe(true);
        const current = expectDefined(
          before.flatMap((job) => job.groups).find((group) => group.shard_name === owner),
          "parallel owner",
        );
        expect(current.timing_key).not.toBe(owner);
        const files = expectDefined(current.includePatterns, "complete parallel owner inventory");
        if (files.length > 1) {
          const legacy = createCompactSplitTimingGeneration({
            configs: current.configs,
            parentShardName: owner,
            stripes: [files.slice(0, 1), files.slice(1)],
          });
          const mismatched = createCompactSplitTimingGeneration({
            configs: current.configs,
            parentShardName: owner,
            stripes: [files.slice(1)],
          });
          const complete = Object.fromEntries(legacy.timingKeys.map((key) => [key, 120]));
          for (const scenario of [
            { observations: { [legacy.timingKeys[0]!]: 240 }, expected: fallback },
            { observations: { [mismatched.timingKeys[0]!]: 240 }, expected: fallback },
            { observations: complete, expected: profile === "hybrid" ? 104 : 120 },
          ]) {
            Object.assign(timings, scenario.observations);
            const plan = createNodeTestShardBundles(options);
            expect(
              plan.reduce(
                (sum, job) =>
                  sum + expectDefined(job.predictedSeconds, "predicted compact seconds"),
                0,
              ),
            ).toBe(scenario.expected);
            for (const key of Object.keys(scenario.observations)) {
              delete timings[key];
            }
          }
          Object.assign(timings, complete);
        }
        timings[current.timing_key!] = 99;
        const after = createNodeTestShardBundles(options);
        expect(
          after.reduce(
            (sum, job) => sum + expectDefined(job.predictedSeconds, "predicted compact seconds"),
            0,
          ),
        ).toBe(measured);
        expect(
          after.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!)).toSorted(),
        ).toEqual(owners.flatMap((shard) => shard.includePatterns!).toSorted());
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
      }
    },
  );

  it("retains each singleton auto-reply stripe's full cost when splitting a parallel parent", () => {
    const original = fullSuiteVitestShards.slice();
    const config = "test/vitest/vitest.auto-reply-reply.config.ts";
    const owner = "auto-reply-reply-state-routing";
    const files = expectDefined(
      defaultShards.find((shard) => shard.shardName === owner)?.includePatterns,
      "mutable planner inventory fixture",
    );
    const originalFiles = files.slice();
    fullSuiteVitestShards.splice(
      0,
      fullSuiteVitestShards.length,
      ...original
        .map((shard) => ({
          ...shard,
          projects: shard.projects.filter((candidate) => candidate === config),
        }))
        .filter((shard) => shard.projects.length > 0),
    );
    try {
      files.splice(
        0,
        files.length,
        "src/auto-reply/reply/parallel-fixture-a.test.ts",
        "src/auto-reply/reply/parallel-fixture-b.test.ts",
      );
      const timings = {
        ...Object.fromEntries(createNodeTestShards().map((shard) => [shard.shardName, 0])),
        [owner]: 400,
      };
      vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
      const options = {
        compactMode: "pull-request" as const,
        includeReleaseOnlyPluginShards: false,
        runnerBackend: "github",
      };
      const plan = createNodeTestShardBundles(options);
      const children = plan.flatMap((job) =>
        job.groups.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)),
      );
      expect(children).toHaveLength(2);
      expect(children.map((group) => group.includePatterns?.length)).toEqual([1, 1]);
      expect(children.flatMap((group) => group.includePatterns!).toSorted()).toEqual(files);
      expect(
        plan.reduce(
          (sum, job) => sum + expectDefined(job.predictedSeconds, "predicted compact seconds"),
          0,
        ),
      ).toBe(400);
      Object.assign(timings, Object.fromEntries(children.map((group) => [group.timing_key!, 200])));
      const measured = createNodeTestShardBundles(options);
      expect(
        measured.reduce(
          (sum, job) => sum + expectDefined(job.predictedSeconds, "predicted compact seconds"),
          0,
        ),
      ).toBe(400);
      expect(
        measured.flatMap((job) =>
          job.groups.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)),
        ),
      ).toEqual(children);
    } finally {
      files.splice(0, files.length, ...originalFiles);
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
    }
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "prices serial Gateway server measurements at two workers and preserves parallel samples (%s)",
    (runnerBackend) => {
      const config = "test/vitest/vitest.gateway-server.config.ts";
      const owner = "agentic-control-plane-agent-chat";
      const original = fullSuiteVitestShards.slice();
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...original
          .map((shard) => ({
            ...shard,
            projects: shard.projects.filter((candidate) => candidate === config),
          }))
          .filter((shard) => shard.projects.length > 0),
      );
      try {
        const timings: Record<string, number> = { [owner]: 540 };
        vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
        vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
        const options = { compactMode: "pull-request" as const, runnerBackend };
        const select = () =>
          createNodeTestShardBundles(options)
            .flatMap((job) => job.groups)
            .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner);
        const inherited = select();
        expect(inherited).toHaveLength(2);
        expect(inherited.every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2")).toBe(
          true,
        );
        const parallelParent = expectDefined(
          parseCompactSplitTimingKey(inherited[0]!.timing_key!)?.parentShardName,
          "parallel measurement parent",
        );
        expect(parallelParent).not.toBe(owner);
        const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...serialEnv } = inherited[0]!.env!;
        const serialGeneration = createCompactSplitTimingGeneration({
          configs: [config],
          env: serialEnv,
          parentShardName: owner,
          stripes: inherited.map((group) => group.includePatterns!),
        });
        timings[serialGeneration.timingKeys[0]!] = 500;
        expect(select()).toHaveLength(2);
        timings[serialGeneration.timingKeys[1]!] = 500;
        expect(select()).toHaveLength(4);
        timings[`${owner}-parallel-native-serial`] = 440;
        const measured = select();
        expect(measured).toHaveLength(3);
        expect(measured.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
          inherited.flatMap((group) => group.includePatterns!).toSorted(),
        );
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
      }
    },
  );

  it("charges native fixture spans before discounting concurrent Gateway work", async () => {
    const config = "test/vitest/vitest.gateway-server.config.ts";
    const owner = "agentic-control-plane-agent-chat";
    const files = [
      gatewayServerSerialTestFiles[0]!,
      "src/gateway/server.chat.fixture-a.test.ts",
      "src/gateway/server.chat.fixture-b.test.ts",
    ];
    const timings: Record<string, number> = { [owner]: 230 };
    vi.resetModules();
    vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
      fullSuiteVitestShards: [{ name: "agentic", config, projects: [config] }],
    }));
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (root: string) => (root === "src/gateway" ? files : []),
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
      ...testTimings,
      readCompactGroupTimings: () => timings,
      readRuntimePlacementTimings: () => [],
    }));
    try {
      const { createNodeTestShardBundles: createPlan } =
        await import("../../scripts/lib/ci-node-test-plan.mts");
      const options = { compactMode: "push" as const, runnerBackend: "blacksmith" };
      const initial = createPlan(options);
      expect(initial).toHaveLength(1);
      expect(initial[0]?.predictedSeconds).toBe(130);
      const parentKey = expectDefined(initial[0]?.groups[0]?.timing_key, "mixed phase timing key");
      expect(parentKey).toContain("native-serial");
      timings[parentKey] = 230;
      const split = createPlan(options);
      expect(split.map((job) => job.predictedSeconds).toSorted((a, b) => a! - b!)).toEqual([
        30, 200,
      ]);
      expect(
        split
          .flatMap((job) => job.groups)
          .flatMap((group) => group.includePatterns!)
          .toSorted(),
      ).toEqual(files.toSorted());
      const native = expectDefined(
        split.find((job) => job.groups.some((group) => group.includePatterns?.includes(files[0]!))),
        "native singleton",
      );
      expect(native.groups.flatMap((group) => group.includePatterns!)).toEqual([files[0]]);
      expect(native.predictedSeconds).toBe(30);
    } finally {
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.resetModules();
    }
  });

  it("keeps parallel singleton measurements separate from the legacy serial floor", async () => {
    const config = "test/vitest/vitest.gateway-server.config.ts";
    const owner = "agentic-control-plane-runtime-server";
    const files = [
      "src/gateway/server-sidecar-retention.test.ts",
      "src/gateway/server-file-fixtures.test.ts",
    ];
    const timings: Record<string, number> = { [owner]: 200 };
    vi.resetModules();
    vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
      fullSuiteVitestShards: [{ name: "agentic", config, projects: [config] }],
    }));
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (root: string) => (root === "src/gateway" ? files : []),
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
      ...testTimings,
      readCompactGroupTimings: () => timings,
      readRuntimePlacementTimings: () => [],
    }));
    try {
      const { createNodeTestShardBundles: createPlan } =
        await import("../../scripts/lib/ci-node-test-plan.mts");
      const options = { compactMode: "push" as const, runnerBackend: "blacksmith" };
      const initial = createPlan(options);
      const groups = initial.flatMap((job) => job.groups);
      expect(groups.map((group) => group.includePatterns?.length)).toEqual([1, 1]);
      expect(groups.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
        files.toSorted(),
      );
      const keys = groups.map((group) => expectDefined(group.timing_key, "singleton timing key"));
      const parent = expectDefined(
        parseCompactSplitTimingKey(keys[0]!),
        "parallel family",
      ).parentShardName;
      const seconds = () =>
        createPlan(options).reduce((sum, job) => sum + (job.predictedSeconds ?? 0), 0);
      // One runtime preparation costs 100s; both singleton files retain their serial floor.
      expect(seconds()).toBe(300);
      // Two 300s files still cost 300s each when a 300s parallel parent is split.
      timings[`${owner}-parallel`] = 300;
      expect(seconds()).toBe(700);
      delete timings[`${owner}-parallel`];
      for (const key of keys) {
        timings[key] = 300;
      }
      expect(seconds()).toBe(700);
      timings[parent] = 600;
      expect(seconds()).toBe(700);
      for (const key of keys) {
        delete timings[key];
      }
      expect(seconds()).toBe(700);
      for (const key of keys) {
        timings[key] = 300;
      }
      timings[parent] = 400;
      expect(seconds()).toBe(700);
      delete timings[parent];
      for (const key of keys) {
        timings[key] = 30;
      }
      expect(seconds()).toBe(300);
      timings[parent] = 700;
      expect(seconds()).toBe(800);
    } finally {
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.resetModules();
    }
  });

  it("keeps Chromium files in the UI CI owner and Node-driven Playwright files in Node stripes", () => {
    const shards = defaultShards;
    const uiStripes = shards.filter((shard) =>
      shard.shardName.startsWith("core-runtime-media-ui-"),
    );
    const files = uiStripes.flatMap((shard) => shard.includePatterns ?? []);
    expect(files).toContain("ui/src/components/form-controls.browser.test.ts");
    expect(files).not.toContain("ui/src/components/markdown-mermaid.runtime.browser.test.ts");
    expect(shards.flatMap((shard) => shard.configs)).not.toContain(
      "test/vitest/vitest.ui-browser.config.ts",
    );
  });
  it.each(["github", "hybrid"])("keeps oversized sparse groups nonempty on %s", (runnerBackend) => {
    const native = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const targets = [1, 2].map((count) =>
      native.find(
        (shard) =>
          shard.includePatterns?.length === count && !shard.shardName.startsWith("core-tooling"),
      )!,
    );
    expect(targets.every(Boolean)).toBe(true);
    const original = testTimings.readCompactGroupTimings;
    vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
      ...original(profile),
      ...Object.fromEntries(targets.map((target) => [target.shardName, 1_000])),
    }));
    const plan = createNodeTestShardBundles({
      compactMode: "push",
      runnerBackend,
      includeReleaseOnlyPluginShards: false,
    });
    for (const target of targets) {
      const groups = plan
        .flatMap((job) => job.groups)
        .filter(
          (group) =>
            group.shard_name === target.shardName ||
            group.shard_name.startsWith(`${target.shardName}-hosted-`),
        );
      expect(groups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
      expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        target.includePatterns!.toSorted(),
      );
      expect(groups).toHaveLength(target.includePatterns!.length);
    }
  });

  it.each([
    { runnerBackend: "github", slowerProfile: "github" },
    { runnerBackend: "hybrid", slowerProfile: "github" },
    { runnerBackend: "hybrid", slowerProfile: "blacksmith" },
  ])(
    "bounds $runnerBackend child groups by the slower $slowerProfile path",
    ({ runnerBackend, slowerProfile }) => {
      // This lane still uses profile-specific group spans; tooling now prices
      // current per-file costs and has separate worker/longest-file coverage.
      const target = {
        ...createNodeTestShards().find((shard) => shard.shardName === "core-runtime-config")!,
        includePatterns: listMatchedTestFiles(createRuntimeConfigVitestConfig({})),
      };
      const runtimeFiles = new Set(listVitestRuntimeConsumerFiles(target.configs));
      const runtimeConsumers = target.includePatterns.filter((file) => runtimeFiles.has(file));
      const buildMode = "runtime";
      const originalShards = fullSuiteVitestShards.slice();
      // Exercise this owner's split without consuming unrelated suite families' job budget.
      const fixtureShards = originalShards
        .map((shard) => ({
          ...shard,
          projects: shard.projects.filter((config) => target.configs.includes(config)),
        }))
        .filter((shard) => shard.projects.length > 0);
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
      try {
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
          [target.shardName]: profile === slowerProfile ? 400 : 100,
        }));
        const plan = createNodeTestShardBundles({
          compactMode: "pull-request",
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
        });
        const groups = plan
          .flatMap((job) => job.groups)
          .filter((group) => group.shard_name.startsWith(`${target.shardName}-hosted-`));
        // Runtime consumers share one isolated build child; its fixed build may
        // exceed the cap. Remaining work needs three stripes on both profiles.
        expect(groups).toHaveLength(4);
        if (runnerBackend === "github") {
          expect(
            plan
              .filter((job) => job.predictedSeconds! > 150)
              .every((job) => {
                if (job.groups.length > 1 && job.pretestBuildMode) {
                  return (
                    job.predictedSeconds! <= 210 &&
                    job.planConcurrency === 1 &&
                    !job.requiresDist &&
                    job.groups.every((group) => group.pretestBuildMode)
                  );
                }
                return (
                  job.groups.length === 1 &&
                  (job.groups[0]!.includePatterns?.length === 1 ||
                    (job.pretestBuildMode === buildMode &&
                      job.groups[0]!.includePatterns?.length === runtimeConsumers.length &&
                      job.groups[0]!.includePatterns?.every((file) =>
                        runtimeConsumers.some((runtimeConsumer) => runtimeConsumer === file),
                      )))
                );
              }),
          ).toBe(true);
        }
        expect(
          groups
            .filter((group) => group.pretestBuildMode !== undefined)
            .map(({ pretestBuildMode, includePatterns }) => ({
              pretestBuildMode,
              includePatterns,
            })),
        ).toEqual([{ pretestBuildMode: buildMode, includePatterns: runtimeConsumers }]);
        for (const job of plan) {
          if (
            job.groups.some(
              (group) => groups.includes(group) && group.pretestBuildMode === undefined,
            )
          ) {
            expect(job.predictedSeconds, `${runnerBackend}/${slowerProfile}`).toBeLessThanOrEqual(
              150,
            );
          }
        }
        expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
          target.includePatterns!.toSorted(),
        );
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );
  afterEach(() => {
    vi.restoreAllMocks();
    if (plannerHostPinned) {
      vi.unstubAllEnvs();
      syncBuiltinESMExports();
      committedCompactPlans.clear();
      plannerHostPinned = false;
    }
  });

  it("inventories source-scanning Control UI policy tests", () => {
    expect(resolvePolicyTestTargets(["ui/src/pages/chat/view.ts"])).toEqual([
      "ui/src/components/web-awesome-migration.node.test.ts",
      "ui/src/styles/base-theme-tokens.node.test.ts",
      "ui/src/styles/cursor-policy.node.test.ts",
    ]);
    expect(resolvePolicyTestTargets(["docs/web/control-ui.md"])).toEqual([]);
    expect(resolvePolicyTestTargets(["extensions/anthropic/openclaw.plugin.json"])).toEqual([
      "src/agents/model-ref-shared.test.ts",
    ]);
  });

  it("selects the core root budget guard alongside changed messaging test owners", () => {
    const guard = "test/scripts/tsgo-core-test-shards.test.ts";
    const changed = "src/infra/outbound/outbound-send-service.accepted-outcomes.test.ts";
    const shards = expectDefined(createChangedNodeTestShards([changed]), "core test plan");
    const targets = shards.flatMap((shard) =>
      (shard.targets ?? []).concat(
        (shard.groups ?? []).flatMap((group) => group.includePatterns ?? []),
      ),
    );
    expect(targets).toContain(changed);
    expect(targets.filter((target) => target === guard)).toEqual([guard]);
    for (const changedPath of [
      "src/auto-reply/reply/new.test.tsx",
      "src/infra/outbound/new.test.ts",
      "test/tsconfig/tsconfig.core.test.messaging.json",
    ]) {
      expect(resolvePolicyTestTargets([changedPath]), changedPath).toContain(guard);
      expect(isPolicyTestOwnedPath(changedPath), changedPath).toBe(false);
    }
    for (const changedPath of [
      "src/infra/outbound/message.ts",
      "src/infra/outbound/message.test-support.ts",
      "src/agents/new.test.tsx",
      "ui/src/pages/new.test.ts",
      "packages/example/new.test.tsx",
      "extensions/example/new.test.ts",
    ]) {
      expect(resolvePolicyTestTargets([changedPath]), changedPath).not.toContain(guard);
    }
  });

  it("selects provisioning for extracted sources without replacing their test owners", () => {
    const provision = "test/scripts/pr-worktree-provision.test.ts";
    const manifest = "scripts/pr-lib/wrapper-components.txt";
    for (const changedPath of [
      "scripts/pr",
      "scripts/pr-lib/worktree.sh",
      "src/plugins/discovery.ts",
      "src/plugins/discovery-availability.ts",
    ]) {
      expect(resolvePolicyTestTargets([changedPath]), changedPath).toContain(provision);
      expect(isPolicyTestOwnedPath(changedPath), changedPath).toBe(false);
    }
    expect(resolvePolicyTestTargets(["src/plugins/unrelated-new-plugin.ts"])).not.toContain(
      provision,
    );
    expect(isPolicyTestOwnedPath(manifest)).toBe(true);
    const shards = expectDefined(createChangedNodeTestShards([manifest]), "manifest test plan");
    const owners = shards
      .flatMap((shard) => shard.groups ?? [])
      .filter((group) => group.includePatterns?.includes(provision));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
  });

  it("matches policy owners only for exact changed paths", () => {
    const changedPath = "ui/src/styles/base.css";
    expect(isPolicyTestOwnedPath(changedPath)).toBe(true);
    expect(resolvePolicyTestTargets([changedPath])).not.toEqual([]);
    for (const lookalike of [` ${changedPath}`, String.raw`ui\src\pages\chat\view.ts`]) {
      expect(isPolicyTestOwnedPath(lookalike), lookalike).toBe(false);
      expect(resolvePolicyTestTargets([lookalike]), lookalike).toEqual([]);
    }
  });

  it("projects cache-warm groups from the owned node test plan", () => {
    const groups = createVitestCacheWarmGroups();
    expect(groups).toHaveLength(12);
    expect(groups.every((group) => group.configs.length === 1)).toBe(true);
    expect(new Set(groups.flatMap((group) => group.configs))).toHaveProperty("size", 11);
    expect(new Set(groups.map((group) => group.shard_name))).toHaveProperty("size", groups.length);

    const coreStripeGroups = groups.filter(
      (group) => group.configs[0] === "test/vitest/vitest.unit-fast.config.ts",
    );
    expect(coreStripeGroups).toHaveLength(2);
    expect(coreStripeGroups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
    const coreStripePatterns = coreStripeGroups.flatMap((group) => group.includePatterns ?? []);
    expect(new Set(coreStripePatterns).size).toBe(coreStripePatterns.length);

    const isolatedGroups = groups.filter(
      (group) =>
        group.shard_name.startsWith("cache-warm:core-unit-fast-isolated:") ||
        group.shard_name.startsWith("cache-warm:core-unit-fast-fake-timers:"),
    );
    expect(isolatedGroups).toHaveLength(2);
    expect(isolatedGroups.every((group) => group.includePatterns === undefined)).toBe(true);
    expect(isolatedGroups.every((group) => group.env === undefined)).toBe(true);

    const embeddedGroups = groups.filter((group) =>
      group.shard_name.startsWith("cache-warm:agentic-agents-embedded:"),
    );
    expect(embeddedGroups).toHaveLength(4);
    expect(
      embeddedGroups.every((group) => group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS === "660000"),
    ).toBe(true);

    const gatewayGroups = groups.filter((group) =>
      group.shard_name.startsWith("cache-warm:agentic-gateway-methods:"),
    );
    expect(
      gatewayGroups.flatMap((group) => group.configs).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([
      "test/vitest/vitest.gateway-methods-isolated.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
    ]);
    expect(gatewayGroups.every((group) => group.includePatterns === undefined)).toBe(true);
    expect(gatewayGroups.every((group) => group.env === undefined)).toBe(true);

    const autoReplyGroups = groups.filter((group) =>
      group.shard_name.startsWith("cache-warm:auto-reply-reply-commands-3:"),
    );
    expect(autoReplyGroups).toHaveLength(1);
    const autoReplyShard = expectDefined(
      defaultShards.find((shard) => shard.shardName === "auto-reply-reply-commands-3"),
      "auto-reply command shard",
    );
    expect(autoReplyGroups[0]?.includePatterns).toEqual(autoReplyShard.includePatterns);
    expect(autoReplyGroups[0]?.env).toBeUndefined();

    expect(groups.find((group) => group.shard_name === "cache-warm:ui-package")).toEqual({
      configs: ["ui/vitest.config.ts"],
      env: { OPENCLAW_VITEST_MAX_WORKERS: "1" },
      includePatterns: [
        "ui/src/components/app-sidebar.catalog.test.ts",
        "ui/src/components/app-sidebar.interactions.test.ts",
        "ui/src/components/app-sidebar.people.test.ts",
        "ui/src/components/app-sidebar.sessions.test.ts",
        "ui/src/pages/chat/chat-view.test.ts",
        "ui/src/pages/chat/chat-pane-lifecycle.test.ts",
        "ui/src/pages/usage/metrics.node.test.ts",
      ],
      shard_name: "cache-warm:ui-package",
    });
  });

  it("bounds the hybrid hosted seed to real consumer configs without runtime builds", () => {
    const groups = createVitestCacheWarmGroups("hybrid-hosted");
    expect(groups).toHaveLength(7);

    expect(groups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
    const files = groups.flatMap((group) => group.includePatterns ?? []);
    expect(files).toHaveLength(17);
    expect(files.every((file) => existsSync(file))).toBe(true);
    expect(buildPrerequisites.resolveVitestPretestBuildMode(groups)).toBeUndefined();
    const tooling = expectDefined(
      groups.find((group) => group.shard_name === "cache-warm:hosted-tooling"),
      "hosted tooling seed",
    );
    expect(
      createVitestRunSpecs(expectDefined(tooling.includePatterns, "hosted tooling files"), {
        baseEnv: { CI: "true", OPENCLAW_TEST_PROJECTS_PARALLEL: "3" },
      }).map((spec) => spec.config),
    ).toEqual(tooling.configs);
    const configs = groups.flatMap((group) => group.configs);
    expect(configs).toContain("test/vitest/vitest.tooling.config.ts");
    expect(configs).toContain("ui/vitest.config.ts");
    expect(configs.filter((config) => config.includes("vitest.contracts-"))).toHaveLength(5);
    expect(groups.find((group) => group.configs[0] === "ui/vitest.config.ts")).toEqual(
      createVitestCacheWarmGroups().find((group) => group.configs[0] === "ui/vitest.config.ts"),
    );
  });

  it("creates split shards without walking test roots", () => {
    const payload = expectNoNodeFsScans<{
      includePatterns: number;
      shards: number;
    }>(`
      const { createNodeTestShards } = await import("./scripts/lib/ci-node-test-plan.mts");
      const shards = createNodeTestShards();
      return {
        includePatterns: shards.reduce(
          (total, shard) => total + (shard.includePatterns?.length ?? 0),
          0,
        ),
        shards: shards.length,
      };
    `);
    expect(payload.shards).toBeGreaterThan(0);
    expect(payload.includePatterns).toBeGreaterThan(0);
  });

  it("bundles split shards with deterministic unique identities and unchanged coverage", () => {
    const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const bundled = createNodeTestShardBundles({ includeReleaseOnlyPluginShards: false });
    const basePatterns = base
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const bundledPatterns = bundled
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(bundled.length).toBeLessThan(base.length);
    expect(new Set(bundled.map((shard) => shard.checkName)).size).toBe(bundled.length);
    expect(bundledPatterns).toEqual(basePatterns);
    expect(
      bundled
        .filter((shard) => shard.shardName.startsWith("bundle-"))
        .every((shard) => (shard.includePatterns?.length ?? 0) <= 64),
    ).toBe(true);
    expect(bundled.every((shard) => shard.runner?.startsWith("blacksmith-"))).toBe(true);
    expect(bundled).toEqual(createNodeTestShardBundles({ includeReleaseOnlyPluginShards: false }));
    expect(bundled.slice(0, 7).map((shard) => shard.shardName)).toEqual([
      "core-unit-fast-1",
      "core-unit-fast-2",
      "core-tooling-1",
      "core-tooling-10",
      "core-tooling-11",
      "core-tooling-12",
      "core-tooling-13",
    ]);
    expect(bundled.find((shard) => shard.shardName === "core-unit-fast-1")?.runner).toBe(
      DEFAULT_NODE_TEST_RUNNER,
    );
    expect(bundled.find((shard) => shard.shardName === "core-unit-fast-2")?.runner).toBe(
      DEFAULT_NODE_TEST_RUNNER,
    );
    expect(
      bundled.find((shard) => shard.shardName === "agentic-control-plane-startup-health-runtime")
        ?.env,
    ).toEqual({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" });
    expect(
      bundled.find((shard) => shard.shardName === "agentic-control-plane-startup-core")?.runner,
    ).toBe(DEFAULT_NODE_TEST_RUNNER);
    expect(bundled.find((shard) => shard.shardName === "bundle-infra-small-1")?.runner).toBe(
      "blacksmith-4vcpu-ubuntu-2404",
    );
    expect(
      new Set(
        bundled
          .filter((shard) => shard.shardName.startsWith("bundle-"))
          .flatMap((shard) => shard.configs),
      ),
    ).toEqual(new Set(["test/vitest/vitest.infra.config.ts"]));
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-commands-"))).toBe(false);
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-cron-"))).toBe(false);
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-agents-core-"))).toBe(false);
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-gateway-server-"))).toBe(
      false,
    );
  });

  it.each([
    { profile: "blacksmith", legacy: 116, measured: 310, defaultSeconds: 25 },
    { profile: "github", legacy: 186, measured: 370, defaultSeconds: 40 },
    { profile: "hybrid", legacy: 101, measured: 270, defaultSeconds: 22 },
  ])(
    "prefers $profile measurements while retaining unmeasured hints and defaults",
    ({ profile, legacy, measured, defaultSeconds }) => {
      const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
      const options = {
        includeReleaseOnlyPluginShards: false,
        compactMode: "pull-request" as const,
        runnerBackend: profile,
      };
      const fallback = createNodeTestShardBundles(options);
      const tuiJob = (plan: typeof fallback) =>
        plan.find((shard) =>
          shard.groups.some((group) => group.shard_name === "core-runtime-tui-pty"),
        );
      expect(tuiJob(fallback)?.predictedSeconds).toBe(legacy);
      timings.mockImplementation((runner) => ({
        "core-runtime-tui-pty": runner === "blacksmith" ? 310 : 370,
        "removed-test-group": 999,
      }));
      const updated = createNodeTestShardBundles(options);
      expect(tuiJob(updated)?.groups.map((group) => group.shard_name)).toEqual([
        "core-runtime-tui-pty",
      ]);
      expect(tuiJob(updated)?.predictedSeconds).toBe(measured);
      expect(
        updated.find((shard) =>
          shard.groups.some((group) => group.shard_name === "core-support-boundary"),
        )?.predictedSeconds,
      ).toBe(defaultSeconds);
      const groupNames = (plan: typeof fallback) =>
        plan.flatMap((shard) => shard.groups.map((group) => group.shard_name)).toSorted();
      expect(groupNames(updated)).toEqual(groupNames(fallback));

      // Two complete, compatible configs share setup without changing either
      // process envelope. Blacksmith placements request capacity for overlapping plans.
      const fixtureConfigs = new Set([
        "test/vitest/vitest.hooks.config.ts",
        "test/vitest/vitest.secrets.config.ts",
      ]);
      const originalShards = fullSuiteVitestShards.slice();
      try {
        const fixtureShards = originalShards
          .map((shard) => ({
            ...shard,
            projects: shard.projects.filter((config) => fixtureConfigs.has(config)),
          }))
          .filter((shard) => shard.projects.length > 0);
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
        const base = createNodeTestShards(options);
        expect(base).toHaveLength(2);
        const groupSeconds = profile === "github" ? 70 : 170;
        timings.mockReturnValue(
          Object.fromEntries(base.map((shard) => [shard.shardName, groupSeconds])),
        );
        const packed = createNodeTestShardBundles(options);
        expect(packed).toHaveLength(1);
        expect(packed[0]?.groups).toEqual(
          base.map(({ checkName: _checkName, shardName, ...group }) => ({
            ...group,
            shard_name: shardName,
          })),
        );
        expect(packed[0]?.planConcurrency).toBe(profile === "github" ? 1 : 2);
        expect(packed[0]?.runner).toBe(
          profile === "github" ? base[0]?.runner : EXTRA_LARGE_NODE_TEST_RUNNER,
        );
        expect(packed[0]?.predictedSeconds).toBe(profile === "hybrid" ? 296 : groupSeconds * 2);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }

      // Cheap envelopes use the time budget instead of creating extra
      // runners at ten groups; serial placements keep their existing count limit.
      timings.mockReturnValue(
        Object.fromEntries(createNodeTestShards(options).map((shard) => [shard.shardName, 1])),
      );
      const dense = createNodeTestShardBundles(options);
      expect(dense.some((shard) => shard.groups.length > 10)).toBe(profile !== "github");
      for (const shard of dense.filter((entry) => entry.groups.length > 10)) {
        expect(shard).toMatchObject({
          planConcurrency: shard.groups.some((group) => group.configs.some(isExclusiveCiTestConfig))
            ? 1
            : 2,
          requiresDist: false,
          runner: EXTRA_LARGE_NODE_TEST_RUNNER,
        });
        expect(shard.pretestBuildMode).toBeUndefined();
        expect(shard.predictedSeconds).toBeLessThanOrEqual(500);
      }
    },
  );

  it("keeps hybrid fallback bounds when other measurements change", () => {
    vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
    const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    const options = {
      includeReleaseOnlyPluginShards: false,
      compactMode: "push" as const,
      runnerBackend: "hybrid",
    };
    const fallback = createNodeTestShardBundles(options);
    const commandRuntimeJobs = fallback.filter((job) =>
      job.groups.some((group) => group.shard_name === "agentic-commands-runtime"),
    );
    expect(commandRuntimeJobs).toHaveLength(1);
    const commandRuntimeJob = expectDefined(commandRuntimeJobs[0], "command runtime job");
    // The refusal file alone costs ceil(194.3 × 0.87 + 100) = 270s with its runtime build.
    expect(commandRuntimeJob).toMatchObject({
      planConcurrency: 1,
      predictedSeconds: 270,
      pretestBuildMode: "runtime",
      requiresDist: false,
    });
    expect(commandRuntimeJob.groups).toHaveLength(1);
    const commandRuntimeGroup = expectDefined(commandRuntimeJob.groups[0], "command runtime group");
    expect(commandRuntimeGroup).toMatchObject({
      configs: ["test/vitest/vitest.commands.config.ts"],
      pretestBuildMode: "runtime",
      requiresDist: false,
      shard_name: "agentic-commands-runtime",
    });
    expect(commandRuntimeGroup.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
    expect(commandRuntimeGroup.fallbackMaxWorkers).toBe(2);
    expect(commandRuntimeGroup.includePatterns?.toSorted()).toEqual([
      "src/commands/doctor-config-flow.legacy-composition.test.ts",
      "src/commands/doctor-config-preflight.process.test.ts",
      "src/commands/doctor-config-preflight.refusal.process.test.ts",
      "src/commands/doctor-config-preflight.v17-atomicity.process.test.ts",
      "src/commands/doctor-plugin-install-config.process.test.ts",
    ]);
    expect(
      fallback
        .filter((shard) => !shard.requiresDist && shard !== commandRuntimeJob)
        .every(
          (shard) =>
            (shard.predictedSeconds ?? Infinity) <=
            (usesParallelPacking(shard) ? 500 : isCombinedUnbuiltCliJob(shard) ? 250 : 210),
        ),
    ).toBe(true);
    // Slow process files retain singleton envelopes without inheriting the
    // separate runtime-consumer group's build.
    expect(
      fallback
        .filter((shard) => !shard.requiresDist)
        .filter((shard) =>
          shard.groups.some((group) => isExclusiveCompactShardName(group.shard_name)),
        )
        .filter((shard) => !((shard.predictedSeconds ?? Infinity) <= 150))
        .filter((shard) => !isCombinedUnbuiltCliJob(shard))
        .map((shard) => ({
          groups: shard.groups.map((group) => ({
            configs: group.configs,
            includePatterns: group.includePatterns,
            pretestBuildMode: group.pretestBuildMode,
          })),
          planConcurrency: shard.planConcurrency,
          pretestBuildMode: shard.pretestBuildMode,
          predictedSeconds: shard.predictedSeconds,
        }))
        .toSorted((a, b) =>
          (a.groups[0]!.includePatterns ?? a.groups[0]!.configs)
            .join(",")
            .localeCompare((b.groups[0]!.includePatterns ?? b.groups[0]!.configs).join(",")),
        ),
    ).toEqual([
      {
        groups: [
          {
            configs: ["test/vitest/vitest.cli-process.config.ts"],
            includePatterns: ["src/cli/gateway-backed-exit-health.process.test.ts"],
            pretestBuildMode: undefined,
          },
        ],
        planConcurrency: 1,
        pretestBuildMode: undefined,
        predictedSeconds: 200,
      },
      {
        groups: [
          {
            configs: ["test/vitest/vitest.cli-process.config.ts"],
            includePatterns: ["src/cli/gateway-backed-exit.process.test.ts"],
            pretestBuildMode: undefined,
          },
        ],
        planConcurrency: 1,
        pretestBuildMode: undefined,
        predictedSeconds: 200,
      },
    ]);
    timings.mockImplementation((runner): Readonly<Record<string, number>> =>
      runner === "blacksmith"
        ? {
            "agentic-agents-core-models": 123,
            "core-unit-fast-1": 100,
            "core-runtime-hooks": 80,
          }
        : {},
    );
    const updated = createNodeTestShardBundles(options);
    const tail = updated.find((shard) =>
      shard.groups.some((group) => group.shard_name === "agentic-gateway-core-3"),
    );
    expect(tail?.predictedSeconds).toBeGreaterThanOrEqual(140);
    expect(tail?.predictedSeconds).toBeLessThanOrEqual(usesParallelPacking(tail) ? 500 : 210);
  });

  it("preserves unmeasured Gateway stripes when another cohort's measurement changes", async () => {
    const config = "test/vitest/vitest.gateway-server.config.ts";
    const files = [
      "src/gateway/server.chat.fixture-a.test.ts",
      "src/gateway/server.chat.fixture-b.test.ts",
    ];
    const timings: Record<string, number> = {
      "agentic-control-plane-agent-chat-parallel": 300,
      "core-runtime-hooks": 40,
    };
    vi.resetModules();
    vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
      fullSuiteVitestShards: [
        { name: "agentic", config, projects: [config] },
        { name: "core-runtime", config, projects: ["test/vitest/vitest.hooks.config.ts"] },
      ],
    }));
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (root: string) => (root === "src/gateway" ? files : []),
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
      ...testTimings,
      readCompactGroupTimings: () => timings,
      readRuntimePlacementTimings: () => [],
    }));
    try {
      const { createNodeTestShardBundles: createPlan } =
        await import("../../scripts/lib/ci-node-test-plan.mts");
      const options = { compactMode: "push" as const, runnerBackend: "hybrid" };
      const stripes = (plan: readonly CompactNodeTestShard[]) =>
        plan
          .flatMap((job) => job.groups)
          .filter((group) => group.configs.includes(config))
          .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
      const before = createPlan(options);
      const originalStripes = stripes(before);
      expect(originalStripes).toHaveLength(2);
      expect(originalStripes.map((group) => group.includePatterns?.length)).toEqual([1, 1]);
      expect(originalStripes.flatMap((group) => group.includePatterns!).toSorted()).toEqual(files);
      for (const group of originalStripes) {
        expect(group.timing_key).toBeDefined();
        expect(timings[group.timing_key!]).toBeUndefined();
      }
      timings["core-runtime-hooks"] = 120;
      const after = createPlan(options);
      expect(stripes(after)).toEqual(originalStripes);
      const seconds = (plan: typeof before) =>
        plan.reduce((sum, job) => sum + (job.predictedSeconds ?? 0), 0);
      expect(seconds(before)).toBe(557);
      expect(seconds(after) - seconds(before)).toBe(69);
    } finally {
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.resetModules();
    }
  });

  it.each([
    { profile: "github", timingProfile: "github", addedSeconds: 40 },
    { profile: "hybrid", timingProfile: "blacksmith", addedSeconds: 35 },
  ] as const)(
    "retains parent floors and uses higher $profile child timings without changing test partitions",
    ({ profile, timingProfile, addedSeconds }) => {
      const originalShards = fullSuiteVitestShards.slice();
      const fixtureShards = originalShards
        .map((shard) => ({
          ...shard,
          projects: shard.projects.filter(
            (config) => config === agentVitestProjectOwners.support.config,
          ),
        }))
        .filter((shard) => shard.projects.length > 0);
      // Other families can change packing and job-level rounding without changing these timings.
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
      try {
        const shardName = "agentic-agents-support-hosted-2";
        let directTimings: Readonly<Record<string, number>> = {};
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation(
          (runner): Readonly<Record<string, number>> => ({
            "agentic-agents-support": runner === "blacksmith" ? 165 : 253,
            ...(runner === timingProfile ? directTimings : {}),
          }),
        );
        const options = {
          includeReleaseOnlyPluginShards: false,
          compactMode: "push" as const,
          runnerBackend: profile,
        };
        const unmeasured = createNodeTestShardBundles(options);
        const initialGroup = unmeasured
          .flatMap((shard) => shard.groups)
          .find((group) => group.shard_name === shardName);
        expect(initialGroup?.timing_key).toMatch(
          /^agentic-agents-support#selector-.+#generation-.+#part-2-of-2#include-.+$/u,
        );
        const timingKey = initialGroup!.timing_key!;
        directTimings = { [timingKey]: 1 };
        const belowFloor = createNodeTestShardBundles(options);
        // Both larger samples exceed the parent share, so their delta measures
        // direct timing precedence independently of the retained floor.
        directTimings = { [timingKey]: 200 };
        const baseline = createNodeTestShardBundles(options);
        directTimings = { [timingKey]: 240 };
        const updated = createNodeTestShardBundles(options);
        const totalSeconds = (plan: typeof baseline) =>
          plan.reduce((sum, shard) => sum + (shard.predictedSeconds ?? 0), 0);
        const testPartition = (plan: typeof baseline) =>
          plan
            .flatMap((shard) => shard.groups)
            .map((group) => ({
              name: group.shard_name,
              configs: group.configs,
              includePatterns: group.includePatterns,
              runner: group.runner,
            }))
            .toSorted((a, b) => a.name.localeCompare(b.name));

        expect(totalSeconds(belowFloor)).toBe(totalSeconds(unmeasured));
        expect(totalSeconds(updated) - totalSeconds(baseline)).toBe(addedSeconds);
        expect(testPartition(baseline)).toEqual(testPartition(unmeasured));
        expect(testPartition(updated)).toEqual(testPartition(baseline));
        expect(
          updated.flatMap((shard) => shard.groups).find((group) => group.shard_name === shardName)
            ?.timing_key,
        ).toBe(timingKey);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );

  it("preserves each plugin project inventory when runtime consumers are partitioned", () => {
    const originalArgv = process.argv;
    process.argv = originalArgv.slice(0, 2);
    try {
      const env = { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: undefined };
      const includeFile = join(tempDirs.make("openclaw-plugin-plan-"), "include.json");
      const plan = createNodeTestShardBundles({
        compactMode: "push",
        runnerBackend: "github",
        includeReleaseOnlyPluginShards: true,
      });
      const capacities = new Map([
        [BUNDLED_NODE_TEST_RUNNER, 4],
        [DEFAULT_NODE_TEST_RUNNER, 8],
        [EXTRA_LARGE_NODE_TEST_RUNNER, 32],
      ]);
      for (const job of plan) {
        expect(job.planConcurrency).toBe(1);
        expect(job.runner).toBe(job.groups[0]?.runner);
        for (const group of job.groups) {
          expect(expectDefined(capacities.get(job.runner), "job capacity")).toBeGreaterThanOrEqual(
            expectDefined(capacities.get(group.runner), "group capacity"),
          );
        }
      }
      for (const { config, create } of [
        { config: "test/vitest/vitest.plugins.config.ts", create: createPluginsVitestConfig },
        { config: "test/vitest/vitest.plugin-sdk.config.ts", create: createPluginSdkVitestConfig },
        {
          config: "test/vitest/vitest.plugin-sdk-light.config.ts",
          create: createPluginSdkLightVitestConfig,
        },
      ]) {
        const expected = listMatchedTestFiles(create(env));
        const actual = plan
          .flatMap((job) => job.groups)
          .filter((group) => group.configs.includes(config))
          .flatMap((group) => {
            if (!group.includePatterns) {
              return listMatchedTestFiles(create(env));
            }
            writeFileSync(includeFile, JSON.stringify(group.includePatterns));
            return listMatchedTestFiles(
              create({ ...env, OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
            );
          });
        expect(actual.toSorted(), config).toEqual(expected.toSorted());
        expect(new Set(actual).size, config).toBe(actual.length);
      }
    } finally {
      process.argv = originalArgv;
    }
  });

  it("partitions whole-config runtime consumers from ordinary serial CLI work", () => {
    const originalShards = fullSuiteVitestShards.slice();
    const config = "test/vitest/vitest.cli-process.config.ts";
    const selected = originalShards
      .map((shard) => ({ ...shard, projects: shard.projects.filter((entry) => entry === config) }))
      .filter((shard) => shard.projects.length > 0);
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...selected);
    const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    const options = {
      includeReleaseOnlyPluginShards: false,
      compactMode: "push" as const,
      runnerBackend: "hybrid",
    };
    try {
      const plan = createNodeTestShardBundles(options);
      const runtimeJobs = plan.filter((job) => job.pretestBuildMode);
      expect(runtimeJobs).toHaveLength(1);
      const [runtimeJob] = runtimeJobs;
      expect(runtimeJob).toMatchObject({ planConcurrency: 1, pretestBuildMode: "runtime" });
      expect(runtimeJob!.predictedSeconds).toBeLessThanOrEqual(150);
      expect(runtimeJob!.groups).toHaveLength(1);
      const runtimeFiles = listVitestRuntimeConsumerFiles([config]).toSorted();
      expect(runtimeJob!.groups[0]!.includePatterns?.toSorted()).toEqual(runtimeFiles);
      const catalogFiles = listMatchedTestFiles(createCliProcessVitestConfig({})).toSorted();
      const ordinaryJobs = plan.filter((job) => !job.pretestBuildMode);
      expect(
        ordinaryJobs
          .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
          .toSorted(),
      ).toEqual(catalogFiles.filter((file) => !runtimeFiles.includes(file)));
      for (const job of plan) {
        expect(job).toMatchObject({ planConcurrency: 1, requiresDist: false });
        for (const group of job.groups) {
          expect(group.configs).toEqual([config]);
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
          expect(group.pretestBuildMode).toBe(job.pretestBuildMode);
          expect(group.requiresDist).toBe(false);
        }
      }
      expect(
        plan
          .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
          .toSorted(),
      ).toEqual(catalogFiles);

      // An oversized measured runtime child remains truthful and alone; ordinary
      // files must not inherit its prerequisite through a sibling exemption.
      timings.mockReturnValue(
        Object.fromEntries(runtimeJob!.groups.map((group) => [group.timing_key!, 100])),
      );
      const expensive = createNodeTestShardBundles(options).filter((job) => job.pretestBuildMode);
      expect(expensive).toHaveLength(1);
      // Hybrid scales the 100s sample to 87s, then charges one 100s runtime build.
      expect(expensive[0]).toMatchObject({ predictedSeconds: 187, planConcurrency: 1 });
      expect(expensive[0]!.groups).toHaveLength(1);
      expect(expensive[0]!.groups[0]!.includePatterns?.toSorted()).toEqual(runtimeFiles);
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
    }
  });

  it("spends the hybrid CLI budget only on complete affordable non-build bins", () => {
    const originalShards = fullSuiteVitestShards.slice();
    const originalProcessFiles = cliProcessTestFiles.slice();
    const configs = new Set([
      "test/vitest/vitest.cli.config.ts",
      "test/vitest/vitest.cli-process.config.ts",
    ]);
    const selected = originalShards
      .map((shard) => ({
        ...shard,
        projects: shard.projects.filter((entry) => configs.has(entry)),
      }))
      .filter((shard) => shard.projects.length > 0);
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...selected);
    const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({
      "agentic-cli": 136,
    });
    const options = {
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request" as const,
      runnerBackend: "hybrid",
    };
    try {
      const plan = createNodeTestShardBundles(options);
      const combined = plan.filter(isCombinedUnbuiltCliJob);
      expect(combined).toHaveLength(2);
      const cliJobs = plan.filter((job) =>
        job.groups.some((group) => group.shard_name === "agentic-cli"),
      );
      expect(cliJobs).toHaveLength(1);
      expect(cliJobs[0]).toMatchObject({
        planConcurrency: 1,
        runner: EXTRA_LARGE_NODE_TEST_RUNNER,
      });
      // The combined bin uses the larger CLI budget, beyond the 150s child limit.
      expect(cliJobs[0]!.predictedSeconds).toBeGreaterThan(150);
      expect(cliJobs[0]!.pretestBuildMode).toBeUndefined();
      expect(cliJobs[0]!.groups).toHaveLength(2);
      expect(cliJobs[0]!.groups[0]!.includePatterns).toBeUndefined();
      const processGroups = plan.flatMap((job) =>
        job.groups.filter((group) =>
          group.configs.includes("test/vitest/vitest.cli-process.config.ts"),
        ),
      );
      expect(processGroups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        listMatchedTestFiles(createCliProcessVitestConfig({})).toSorted(),
      );
      expect(
        combined.every((job) => job.predictedSeconds! <= 250 && job.planConcurrency === 1),
      ).toBe(true);
      for (const job of plan.filter((candidate) => candidate.pretestBuildMode)) {
        expect(job.predictedSeconds).toBeLessThanOrEqual(150);
        expect(job.groups.every((group) => group.pretestBuildMode === "runtime")).toBe(true);
      }
      const combinedProcessGroups = combined
        .flatMap((job) => job.groups)
        .filter((group) => group.configs.includes("test/vitest/vitest.cli-process.config.ts"));
      const processKeys = combinedProcessGroups.flatMap((group) =>
        group.timing_key ? [group.timing_key] : [],
      );
      expect(processKeys).toHaveLength(combinedProcessGroups.length);
      expect(new Set(processKeys).size).toBe(processKeys.length);
      // Each child still fits its 150s limit, but two no longer fit a 250s bin.
      timings.mockReturnValue(Object.fromEntries(processKeys.map((key) => [key, 160])));
      const overBudget = createNodeTestShardBundles(options);
      expect(
        overBudget.every(
          (job) =>
            job.groups.filter((group) => processKeys.includes(group.timing_key ?? "")).length <= 1,
        ),
      ).toBe(true);
      // A truthful oversized child must remain alone even beside a tiny CLI.
      timings.mockReturnValue({
        "agentic-cli": 3,
        ...Object.fromEntries(processKeys.map((key) => [key, 200])),
      });
      const oversized = createNodeTestShardBundles(options).filter((job) =>
        job.groups.some((group) => processKeys.includes(group.timing_key ?? "")),
      );
      expect(oversized).toHaveLength(processKeys.length);
      expect(oversized.every((job) => job.groups.length === 1)).toBe(true);

      // Cheaper complete CLI children can share below 150s. A later unrelated
      // non-dist owner must not invalidate that earlier sibling exemption.
      const processFiles = ["src/cli/help-exit.process.test.ts", "src/cli/one-shot-exit.test.ts"];
      cliProcessTestFiles.splice(0, cliProcessTestFiles.length, ...processFiles);
      const smallerConfigs = new Set([
        "test/vitest/vitest.cli-process.config.ts",
        "test/vitest/vitest.tooling-isolated.config.ts",
      ]);
      fullSuiteVitestShards.splice(
        0,
        fullSuiteVitestShards.length,
        ...originalShards
          .map((shard) => ({
            ...shard,
            projects: shard.projects.filter((config) => smallerConfigs.has(config)),
          }))
          .filter((shard) => shard.projects.length > 0),
      );
      timings.mockImplementation((profile) => ({
        "agentic-cli-process": profile === "github" ? 200 : 120,
        "core-tooling-isolated": 20,
      }));
      const cheaper = createNodeTestShardBundles(options);
      const cliJob = cheaper.find((job) =>
        job.groups.some((group) =>
          group.configs.includes("test/vitest/vitest.cli-process.config.ts"),
        ),
      )!;
      expect(cliJob.groups).toHaveLength(2);
      expect(cliJob.groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        processFiles.toSorted(),
      );
      const unrelated = cheaper.find((job) =>
        job.groups.some((group) => group.shard_name === "core-tooling-isolated"),
      )!;
      expect(unrelated).toMatchObject({ runner: cliJob.runner, requiresDist: false });
      expect(unrelated.groups).toHaveLength(1);
      expect(unrelated.pretestBuildMode).toBeUndefined();
      expect(cliJob.predictedSeconds! + unrelated.predictedSeconds!).toBeLessThanOrEqual(150);
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      cliProcessTestFiles.splice(0, cliProcessTestFiles.length, ...originalProcessFiles);
    }
  });

  function checkCommittedCompactPolicies(host: PlannerHost) {
    pinPlannerHost(host);
    const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const compact = getCommittedCompactPlan("push");
    const pullRequestCompact = getCommittedCompactPlan("pull-request");
    const githubCompact = getCommittedCompactPlan("push", "github");
    const githubPullRequestCompact = getCommittedCompactPlan("pull-request", "github");
    const hybridCompact = getCommittedCompactPlan("push", "hybrid");
    const hybridPullRequestCompact = getCommittedCompactPlan("pull-request", "hybrid");
    const placementTimings = vi
      .spyOn(testTimings, "readRuntimePlacementTimings")
      .mockReturnValue([]);
    const hybridBeforePlacement = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request",
      runnerBackend: "hybrid",
    });
    placementTimings.mockRestore();
    const expectedToolingOwnerNames = Array.from(
      { length: 16 },
      (_, index) => `core-tooling-${index + 1}`,
    );
    const pushExcludedShardNames = new Set([
      "core-runtime-tui-pty",
      ...expectedToolingOwnerNames,
      "core-tooling-isolated",
    ]);
    const gatewayFiles = [
      "src/cli/gateway-backed-exit.process.test.ts",
      "src/cli/gateway-backed-exit-health.process.test.ts",
    ];
    const sharesNativeCapacity = (shard: CompactNodeTestShard) =>
      shard.runner === EXTRA_LARGE_NODE_TEST_RUNNER &&
      !shard.requiresDist &&
      !shard.pretestBuildMode &&
      (shard.planConcurrency === 2 ||
        (shard.planConcurrency === 1 &&
          shard.groups.length === 1 &&
          shard.env?.OPENCLAW_VITEST_MAX_WORKERS === "2")) &&
      shard.groups.every(
        (group) =>
          [BUNDLED_NODE_TEST_RUNNER, DEFAULT_NODE_TEST_RUNNER].includes(group.runner) &&
          !group.requiresDist &&
          !group.pretestBuildMode &&
          !isExclusiveCompactShardName(group.shard_name) &&
          !group.configs.some(isExclusiveCiTestConfig),
      );

    for (const profile of [
      {
        name: "Blacksmith",
        pullRequest: pullRequestCompact,
        push: compact,
        largeOwners: [
          "agentic-cli",
          "agentic-control-plane-http-plugin-ws",
          "agentic-commands-doctor-platform",
          "agentic-commands-doctor-sessions-cron",
          "agentic-commands-doctor-sessions-cron-memory",
          "agentic-commands-doctor-sessions-cron-sqlite",
          "agentic-commands-doctor-sessions-cron-sqlite-recovery",
          "agentic-control-plane-auth-node",
          "core-runtime-infra-storage-state",
          "agentic-control-plane-runtime-ui-tools",
          "core-runtime-infra-heartbeat-runner",
          "core-runtime-infra-system-runtime",
          "auto-reply-reply-agent-runner",
          "agentic-commands-status-tools",
          "agentic-commands-doctor",
          "agentic-agents-core-isolated",
        ],
        largeFiles: ["src/cli/update-dry-run-state.process.test.ts"],
      },
      {
        name: "GitHub-hosted",
        pullRequest: githubPullRequestCompact,
        push: githubCompact,
        largeOwners: [
          "core-runtime-cron-parallel-service",
          "agentic-agents-tools",
          "core-runtime-infra-storage-state",
        ],
        largeFiles: [],
      },
      {
        name: "hybrid",
        pullRequest: hybridPullRequestCompact,
        push: hybridCompact,
        largeOwners: [
          "agentic-commands-doctor-config-state",
          "core-runtime-cron-parallel-service",
          "agentic-control-plane-runtime-shared-token",
          "agentic-commands-doctor-platform",
        ],
        largeFiles: gatewayFiles,
      },
    ]) {
      expect(profile.push.length, `${profile.name} excludes PR-only work`).toBeLessThan(
        profile.pullRequest.length,
      );
      for (const [mode, plan] of [
        ["push", profile.push],
        ["pull-request", profile.pullRequest],
      ] as const) {
        // Capacity belongs to the workload even when timing changes reorder rows.
        const groups = plan.flatMap((shard) => shard.groups);
        for (const group of groups.filter((entry) =>
          entry.configs.includes("test/vitest/vitest.commands.config.ts"),
        )) {
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS, group.shard_name).toBeUndefined();
          const job = plan.find((entry) => entry.groups.includes(group))!;
          const workers =
            profile.name !== "GitHub-hosted" &&
            job.runner === EXTRA_LARGE_NODE_TEST_RUNNER &&
            job.planConcurrency === 1 &&
            job.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined
              ? 8
              : 2;
          expect(group.timing_key, group.shard_name).toContain(`#file-parallel-${workers}`);
          expect(group.fallbackMaxWorkers, group.shard_name).toBe(2);
        }
        for (const owner of [
          "agentic-gateway-core-1",
          "agentic-gateway-core-2",
          "agentic-gateway-core-3",
          "agentic-gateway-server-isolated",
        ]) {
          const isolated = owner === "agentic-gateway-server-isolated";
          const gatewayGroups = groups
            .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner)
            // Timing generations follow shard numbers, including double-digit children.
            .toSorted((left, right) =>
              left.shard_name.localeCompare(right.shard_name, undefined, { numeric: true }),
            );
          const measured =
            (owner === "agentic-gateway-core-2" || isolated) && profile.name !== "GitHub-hosted";
          expect(gatewayGroups.length, `${profile.name}: ${owner}`).toBeGreaterThan(0);
          expect(gatewayGroups.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
            isolated
              ? [...gatewayServerIsolatedTestFiles, ...gatewayDatabaseWorkerTestFiles]
                  .filter((file) => mode === "push" || !isCiProofTestFile(file))
                  .toSorted()
              : base.find((shard) => shard.shardName === owner)?.includePatterns?.toSorted(),
          );
          for (const group of gatewayGroups) {
            expect(group.env).toEqual(
              isolated
                ? measured
                  ? { OPENCLAW_VITEST_MAX_WORKERS: "8" }
                  : undefined
                : measured
                  ? undefined
                  : { OPENCLAW_VITEST_MAX_WORKERS: "2" },
            );
            expect(group.fallbackMaxWorkers).toBe(measured ? 2 : undefined);
            expect(group.minTotalMemoryBytes).toBe(
              measured && isolated ? 28 * 1024 ** 3 : undefined,
            );
            const job = expectDefined(
              plan.find((candidate) => candidate.groups.includes(group)),
              owner,
            );
            expect(job.planConcurrency).toBe(1);
            const effectiveWorkers = (entry: (typeof groups)[number]) =>
              Math.min(
                8,
                Number(job.env?.OPENCLAW_VITEST_MAX_WORKERS ?? 8),
                Number(entry.env?.OPENCLAW_VITEST_MAX_WORKERS ?? 8),
              );
            expect(effectiveWorkers(group)).toBe(measured || isolated ? 8 : 2);
            if (measured) {
              expect(job.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
              for (const sibling of job.groups.filter(
                (entry) => entry !== group && usesParallelPacking(job),
              )) {
                expect(effectiveWorkers(sibling), sibling.shard_name).toBe(
                  sibling.fallbackMaxWorkers === 2 ? 8 : 2,
                );
              }
            }
          }
          if (gatewayGroups.length > 1) {
            const generation = createCompactSplitTimingGeneration({
              configs: gatewayGroups[0]!.configs,
              env: gatewayGroups[0]!.env,
              parentShardName: owner,
              stripes: gatewayGroups.map((group) => group.includePatterns!),
            });
            expect(gatewayGroups.map((group) => group.timing_key)).toEqual(generation.timingKeys);
          }
        }
        const parallelAgentGroups = groups.filter((group) =>
          fileParallelAgentGroupNames.has(group.shard_name),
        );
        expect(new Set(parallelAgentGroups.map((group) => group.shard_name))).toEqual(
          fileParallelAgentGroupNames,
        );
        for (const group of parallelAgentGroups) {
          expect(group.timing_key).toBe(`${group.shard_name}#file-parallel`);
          expect(group.fallbackMaxWorkers).toBe(profile.name === "GitHub-hosted" ? undefined : 2);
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
        }
        for (const owner of profile.largeOwners) {
          const selected = groups.filter(
            (group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner,
          );
          expect(selected.length, `${profile.name}: ${owner}`).toBeGreaterThan(0);
          expect(
            selected.every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER),
            `${profile.name}: ${owner}`,
          ).toBe(true);
        }
        for (const largeFile of profile.largeFiles) {
          const selected = groups.filter((group) => group.includePatterns?.includes(largeFile));
          expect(selected, largeFile).toHaveLength(1);
          expect(selected[0]?.runner, largeFile).toBe(DEFAULT_NODE_TEST_RUNNER);
        }
        const supportGroups = groups.filter((group) =>
          group.configs.includes(agentVitestProjectOwners.support.config),
        );
        expect(supportGroups.length, profile.name).toBeGreaterThan(0);
        if (profile.name === "Blacksmith") {
          for (const owner of [
            "agentic-control-plane-agent-chat",
            "agentic-gateway-core-3",
            "core-runtime-infra-storage-state",
          ]) {
            expect(
              groups.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)).length,
              owner,
            ).toBeGreaterThan(1);
          }
          expect(supportGroups).toEqual([
            {
              shard_name: "agentic-agents-support",
              configs: [agentVitestProjectOwners.support.config],
              requiresDist: false,
              runner: EXTRA_LARGE_NODE_TEST_RUNNER,
            },
          ]);
          expect(plan.find((shard) => shard.groups.includes(supportGroups[0]!))).toMatchObject({
            checkName: "checks-node-compact-large32-1",
            shardName: "compact-large32-1",
            groups: supportGroups,
            runner: EXTRA_LARGE_NODE_TEST_RUNNER,
            planConcurrency: 1,
            timeoutMinutes: 120,
          });
        } else {
          expect(supportGroups.every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER)).toBe(
            true,
          );
          if (profile.name === "GitHub-hosted") {
            expect(plan.some((shard) => shard.runner === EXTRA_LARGE_NODE_TEST_RUNNER)).toBe(false);
            expect(plan.every((shard) => shard.planConcurrency === 1)).toBe(true);
          }
        }
        const cliProcessJobs = plan.filter((shard) =>
          shard.groups.some((group) =>
            group.configs.includes("test/vitest/vitest.cli-process.config.ts"),
          ),
        );
        const gatewayJobs = new Set(
          gatewayFiles.map((file) => {
            const gatewayJob = cliProcessJobs.find((shard) =>
              shard.groups.some((group) => group.includePatterns?.includes(file)),
            );
            expect(gatewayJob?.groups, `${profile.name}: ${file}`).toEqual([
              expect.objectContaining({ includePatterns: [file] }),
            ]);
            return gatewayJob;
          }),
        );
        const runtimeCliJobs = cliProcessJobs.filter((shard) => shard.pretestBuildMode);
        for (const file of [
          "src/cli/acp-cli-exit.process.test.ts",
          "src/cli/update-dry-run-state.process.test.ts",
        ]) {
          const job = expectDefined(
            runtimeCliJobs.find((shard) =>
              shard.groups.some((group) => group.includePatterns?.includes(file)),
            ),
            `runtime CLI owner for ${file}`,
          );
          expect(job.pretestBuildMode).toBe(
            job.groups.some((group) => group.includePatterns?.includes(PRIVATE_QA_TOOLING_TEST))
              ? "private-qa"
              : "runtime",
          );
          expect(job.groups).toContainEqual(
            expect.objectContaining({
              pretestBuildMode: "runtime",
              includePatterns: expect.arrayContaining([file]),
            }),
          );
        }
        for (const shard of cliProcessJobs) {
          // Hosted runtime groups share one preparation within 210s; no-build
          // gateway files retain 200s and complete hybrid CLI bins retain 250s.
          const budget = gatewayJobs.has(shard)
            ? 200
            : profile.name === "GitHub-hosted" && shard.pretestBuildMode
              ? 210
              : profile.name === "hybrid" && isCombinedUnbuiltCliJob(shard)
                ? 250
                : 150;
          if (profile.name === "GitHub-hosted" && shard.pretestBuildMode) {
            expect(shard.groups.every((group) => group.pretestBuildMode)).toBe(true);
          }
          expect(shard.predictedSeconds, profile.name).toBeLessThanOrEqual(budget);
        }
        expect(
          plan.every(
            (shard) =>
              shard.groups.length > 0 && (usesParallelPacking(shard) || shard.groups.length <= 10),
          ),
        ).toBe(true);
        expect(plan.every((shard) => Number.isFinite(shard.predictedSeconds))).toBe(true);
        const names = plan.flatMap((shard) => shard.groups.map((group) => group.shard_name));
        expect(new Set(names).size).toBe(names.length);
        expect(new Set(plan.map((shard) => shard.checkName)).size).toBe(plan.length);
        expect(new Set(plan.map((shard) => shard.shardName)).size).toBe(plan.length);
        expect(plan.length, `${profile.name} row budget`).toBeLessThanOrEqual(90);
      }
    }
    expect(compact.every((shard) => Array.isArray(shard.groups))).toBe(true);
    expect(compact.every((shard) => usesParallelPacking(shard) || shard.groups.length <= 10)).toBe(
      true,
    );
    expect(compact.some((shard) => shard.requiresDist)).toBe(true);
    expect(
      compact.every((shard) =>
        shard.groups.every(
          (group) =>
            group.requiresDist === shard.requiresDist &&
            (group.runner === shard.groups[0]?.runner || sharesNativeCapacity(shard)),
        ),
      ),
    ).toBe(true);
    const jobOf = (name: string) =>
      compact.findIndex((shard) => shard.groups.some((group) => group.shard_name === name));
    expect(jobOf("agentic-agents-core-runner-embedded")).toBeGreaterThanOrEqual(0);
    for (const prefix of [
      "agentic-agents-embedded-base",
      "agentic-gateway-core",
      "core-runtime-media-ui",
      "core-unit-src-security",
    ]) {
      const jobs = [1, 2, 3].flatMap((stripe) => {
        const owner = `${prefix}-${stripe}`;
        const placements = compact.flatMap((shard, index) =>
          shard.groups
            .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner)
            .map(() => index),
        );
        expect(placements.length, owner).toBeGreaterThan(0);
        return placements;
      });
      expect(new Set(jobs).size).toBe(jobs.length);
    }
    // Cheap stripes may legally co-locate in one bin; only existence matters.
    for (const owner of ["core-unit-fast-1", "core-unit-fast-2"]) {
      expect(
        compact.some((job) =>
          job.groups.some((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner),
        ),
      ).toBe(true);
    }
    // Timing-sensitive and runtime-building jobs stay serial. Ordinary Blacksmith
    // placements may overlap only with the larger request; logical groups stay intact.
    for (const shard of [
      ...pullRequestCompact,
      ...githubPullRequestCompact,
      ...hybridPullRequestCompact,
    ]) {
      const exclusiveCount = shard.groups.filter((group) =>
        isExclusiveCompactShardName(group.shard_name),
      ).length;
      if (exclusiveCount > 0) {
        expect(exclusiveCount).toBe(shard.groups.length);
        expect(shard.planConcurrency).toBe(1);
      }
      const originalHybridJob = hybridPullRequestCompact.includes(shard)
        ? expectDefined(
            hybridBeforePlacement.find((job) => job.checkName === shard.checkName),
            "original hybrid runner anchor",
          )
        : undefined;
      if (
        originalHybridJob?.planConcurrency === 2 &&
        shard.planConcurrency === 1 &&
        !usesParallelPacking(shard)
      ) {
        expect(shard.pretestBuildMode).toBe("runtime");
      }
      const promoted =
        originalHybridJob !== undefined &&
        originalHybridJob.pretestBuildMode === undefined &&
        shard.pretestBuildMode === "runtime";
      if (promoted) {
        expect(shard.pretestBuildMode).toBe("runtime");
        expect(shard.planConcurrency).toBe(1);
        expect(exclusiveCount).toBe(0);
        expect(shard.requiresDist).toBe(false);
        expect(shard.env).toStrictEqual(originalHybridJob.env);
        for (const original of originalHybridJob.groups) {
          const retained = expectDefined(
            shard.groups.find((group) => group.shard_name === original.shard_name),
            "retained ordinary group",
          );
          // Already-serial recipients keep their job cap; only parallel recipients need group pins.
          if (originalHybridJob.planConcurrency === 2) {
            expect(retained).toEqual({
              ...original,
              env: { OPENCLAW_VITEST_MAX_WORKERS: "2", ...original.env },
            });
          } else {
            expect(retained).toStrictEqual(original);
          }
        }
      }
      if (
        !githubPullRequestCompact.includes(shard) &&
        !exclusiveCount &&
        !shard.requiresDist &&
        !promoted
      ) {
        expect(
          shard.groups.every(
            (group) => Boolean(group.pretestBuildMode) === Boolean(shard.pretestBuildMode),
          ),
        ).toBe(true);
      }
      if (shard.planConcurrency === 2) {
        expect(githubPullRequestCompact).not.toContain(shard);
        expect(shard.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
        expect(shard.groups.length).toBeGreaterThan(1);
        expect(shard.pretestBuildMode).toBeUndefined();
        expect(shard.requiresDist).toBe(false);
      } else {
        expect(shard.planConcurrency).toBe(1);
        const blacksmithTooling =
          pullRequestCompact.includes(shard) &&
          shard.groups.some((group) =>
            group.configs.includes("test/vitest/vitest.tooling.config.ts"),
          );
        const nativeFullCli =
          !githubPullRequestCompact.includes(shard) &&
          shard.groups.some((group) => group.shard_name === "agentic-cli");
        expect(shard.runner).toBe(
          originalHybridJob
            ? originalHybridJob.runner
            : blacksmithTooling ||
                usesParallelPacking(shard) ||
                nativeFullCli ||
                shard.groups[0]?.runner === EXTRA_LARGE_NODE_TEST_RUNNER
              ? EXTRA_LARGE_NODE_TEST_RUNNER
              : !githubPullRequestCompact.includes(shard) &&
                  shard.groups[0]?.runner === BUNDLED_NODE_TEST_RUNNER
                ? DEFAULT_NODE_TEST_RUNNER
                : shard.groups[0]?.runner,
        );
      }
    }
    expect(
      pullRequestCompact.filter((shard) =>
        shard.groups.some((group) => isExclusiveCompactShardName(group.shard_name)),
      ).length,
    ).toBeGreaterThan(0);
    const hybridJobFor = (name: string) =>
      hybridPullRequestCompact.find((shard) =>
        shard.groups.some((group) => group.shard_name === name),
      );
    const hybridCliJob = hybridJobFor("agentic-cli");
    const hybridToolingIsolatedJob = hybridJobFor("core-tooling-isolated");
    expect(hybridCliJob).toBeDefined();
    expect(hybridToolingIsolatedJob).toBeDefined();
    expect(hybridToolingIsolatedJob?.checkName).not.toBe(hybridCliJob?.checkName);
    const expectedEmbeddedAgentGroupNames = [
      "agentic-agents-embedded-base-1",
      "agentic-agents-embedded-base-2",
      "agentic-agents-embedded-base-3",
      "agentic-agents-embedded-incomplete-turn",
      "agentic-agents-embedded-overflow-compaction",
      "agentic-agents-embedded-run",
    ];
    // Scoped configs drop unit-fast files and the shared live/e2e suffixes, so
    // a striped owner covers only the files its config runs; the rest are inert.
    const ownerScopedTestFiles = (owner: { dir: string; include: string[]; exclude: string[] }) => {
      const unitFastFiles = new Set(
        getUnitFastTestFilesForIncludePatterns(owner.include, { dir: owner.dir }),
      );
      return globSync(owner.include)
        .map(toRepoPath)
        .filter(
          (file) =>
            !unitFastFiles.has(file) &&
            !file.endsWith(".live.test.ts") &&
            !file.endsWith(".e2e.test.ts") &&
            !owner.exclude.some((pattern) => matchesGlob(file, pattern)),
        );
    };
    // The embedded composite expands into per-config groups and stripes its
    // base config; whole-config runtime consumers may also be striped.
    const embeddedBaseOwnerFiles = ownerScopedTestFiles(agentVitestProjectOwners.embedded);
    const supportOwnerFiles = ownerScopedTestFiles(agentVitestProjectOwners.support);
    const cliProcessOwnerFiles = listMatchedTestFiles(createCliProcessVitestConfig({}));
    const runtimeConfigOwnerFiles = listMatchedTestFiles(createRuntimeConfigVitestConfig({}));
    const pluginSdkOwnerFiles = listMatchedTestFiles(createPluginSdkVitestConfig({}));
    const pluginSdkLightOwnerFiles = listMatchedTestFiles(createPluginSdkLightVitestConfig({}));
    const gatewayMethodsOwnerFiles = [
      ...listMatchedTestFiles(createGatewayMethodsVitestConfig({})),
      ...listMatchedTestFiles(createGatewayMethodsIsolatedVitestConfig({})),
    ];
    const gatewayServerIsolatedOwnerFiles = [
      ...listMatchedTestFiles(createGatewayServerIsolatedVitestConfig({})),
      ...listMatchedTestFiles(createGatewayDatabaseWorkersVitestConfig({})),
    ];
    const gatewayFilesByConfig = new Map([
      [
        "test/vitest/vitest.gateway-methods.config.ts",
        listMatchedTestFiles(createGatewayMethodsVitestConfig({})),
      ],
      [
        "test/vitest/vitest.gateway-methods-isolated.config.ts",
        listMatchedTestFiles(createGatewayMethodsIsolatedVitestConfig({})),
      ],
      [
        "test/vitest/vitest.gateway-server-isolated.config.ts",
        listMatchedTestFiles(createGatewayServerIsolatedVitestConfig({})),
      ],
      [
        "test/vitest/vitest.gateway-database-workers.config.ts",
        listMatchedTestFiles(createGatewayDatabaseWorkersVitestConfig({})),
      ],
    ]);
    const materializedIncludes = (group: CompactNodeTestShard["groups"][number]) =>
      group.includePatterns ??
      group.configs.flatMap((config) => gatewayFilesByConfig.get(config) ?? []);
    const compactGroups = compact.flatMap((shard) => shard.groups);
    const pullRequestCompactGroups = pullRequestCompact.flatMap((shard) => shard.groups);
    const expectedGroupNames = base.flatMap((shard) =>
      shard.shardName === "agentic-agents-embedded"
        ? expectedEmbeddedAgentGroupNames
        : [shard.shardName],
    );
    const compactOwnerNames = (plan: typeof githubCompact) =>
      new Set(
        plan.flatMap((shard) =>
          shard.groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, "")),
        ),
      );
    expect(compactOwnerNames(compact)).toEqual(
      new Set(expectedGroupNames.filter((name) => !pushExcludedShardNames.has(name))),
    );
    expect(compactOwnerNames(pullRequestCompact)).toEqual(new Set(expectedGroupNames));
    expect(compactOwnerNames(githubCompact)).toEqual(compactOwnerNames(compact));
    expect(compactOwnerNames(githubPullRequestCompact)).toEqual(
      compactOwnerNames(pullRequestCompact),
    );
    expect(compactOwnerNames(hybridCompact)).toEqual(compactOwnerNames(githubCompact));
    expect(compactOwnerNames(hybridPullRequestCompact)).toEqual(
      compactOwnerNames(githubPullRequestCompact),
    );
    for (const plan of [
      compact,
      pullRequestCompact,
      githubCompact,
      githubPullRequestCompact,
      hybridCompact,
      hybridPullRequestCompact,
    ]) {
      const retainsProofTests = [compact, githubCompact, hybridCompact].includes(plan);
      const retainedFiles = (files: string[]) =>
        files.filter((file) => retainsProofTests || !isCiProofTestFile(file));
      const pluginOwners = plan
        .flatMap((shard) => shard.groups)
        .filter((group) =>
          materializedIncludes(group).includes("test/plugins/codex-model-catalog.gateway.test.ts"),
        );
      expect(pluginOwners).toHaveLength(1);
      expect(pluginOwners[0]?.configs).toContain(
        "test/vitest/vitest.gateway-database-workers.config.ts",
      );
      expect(pluginOwners[0]?.pretestBuildMode).toBe("runtime");
      for (const owner of base) {
        const groups = plan
          .flatMap((shard) => shard.groups)
          .filter((group) => group.shard_name.startsWith(`${owner.shardName}-hosted-`));
        if (groups.length === 0) {
          continue;
        }
        const jobs = groups.map((group) => plan.findIndex((shard) => shard.groups.includes(group)));
        for (const jobIndex of new Set(jobs)) {
          const job = plan[jobIndex]!;
          const siblings = groups.filter((group) => job.groups.includes(group));
          if (siblings.length === 1) {
            continue;
          }
          expect(job).toMatchObject({ planConcurrency: 1, requiresDist: false });
          expect(job.predictedSeconds).toBeLessThanOrEqual(job.pretestBuildMode ? 150 : 250);
          expect(job.groups.every((group) => isExclusiveCompactShardName(group.shard_name))).toBe(
            true,
          );
          if (job.pretestBuildMode === undefined) {
            expect([hybridCompact, hybridPullRequestCompact]).toContain(plan);
            expect(isCombinedUnbuiltCliJob(job)).toBe(true);
          } else {
            expect(job.pretestBuildMode).toBe("runtime");
          }
          expect(
            siblings.every((group) => /^agentic-cli-process-hosted-\d+$/u.test(group.shard_name)),
          ).toBe(true);
          expect(siblings.every((group) => group.pretestBuildMode === job.pretestBuildMode)).toBe(
            true,
          );
        }
        const actual = groups.flatMap((group) => group.includePatterns ?? []);
        expect(new Set(actual).size, owner.shardName).toBe(actual.length);
        if (owner.includePatterns) {
          const expectedFiles = [compact, githubCompact, hybridCompact].includes(plan)
            ? owner.includePatterns.filter(
                (file) => !file.startsWith("test/scripts/") && !file.startsWith("src/scripts/"),
              )
            : owner.includePatterns;
          expect(actual.toSorted(), owner.shardName).toEqual(
            retainedFiles(expectedFiles).toSorted(),
          );
        } else if (owner.shardName === "agentic-agents-support") {
          expect(actual.toSorted()).toEqual(supportOwnerFiles.toSorted());
        } else if (owner.shardName === "agentic-cli-process") {
          expect(actual.toSorted()).toEqual(cliProcessOwnerFiles.toSorted());
        } else if (owner.shardName === "core-runtime-config") {
          expect(actual.toSorted()).toEqual(runtimeConfigOwnerFiles.toSorted());
        } else if (owner.shardName === "agentic-gateway-methods") {
          expect(actual.toSorted()).toEqual(gatewayMethodsOwnerFiles.toSorted());
        } else if (owner.shardName === "agentic-gateway-server-isolated") {
          expect(actual.toSorted()).toEqual(
            retainedFiles(gatewayServerIsolatedOwnerFiles).toSorted(),
          );
        }
      }
    }
    // Pushes omit only the explicit low-signal families; PR fallback retains
    // their include-pattern coverage when special setup prevents targeting.
    expect(
      compactGroups.flatMap(materializedIncludes).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      base
        .filter((shard) => !pushExcludedShardNames.has(shard.shardName))
        .flatMap((shard) => shard.includePatterns ?? [])
        .concat(
          embeddedBaseOwnerFiles,
          gatewayMethodsOwnerFiles,
          gatewayServerIsolatedOwnerFiles,
          cliProcessOwnerFiles,
          pluginSdkOwnerFiles,
          pluginSdkLightOwnerFiles,
          runtimeConfigOwnerFiles,
          getUnitFastIsolatedTestFiles(),
          getUnitFastTimerTestFiles(),
        )
        .filter((file) => !file.startsWith("test/scripts/") && !file.startsWith("src/scripts/"))
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(
      pullRequestCompactGroups.flatMap(materializedIncludes).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      base
        .flatMap((shard) => shard.includePatterns ?? [])
        .concat(
          embeddedBaseOwnerFiles,
          gatewayMethodsOwnerFiles,
          gatewayServerIsolatedOwnerFiles,
          cliProcessOwnerFiles,
          pluginSdkOwnerFiles,
          pluginSdkLightOwnerFiles,
          runtimeConfigOwnerFiles,
        )
        .filter((file) => !isCiProofTestFile(file))
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(compact.every((shard) => shard.groups.every((group) => group.configs.length > 0))).toBe(
      true,
    );
    expect(
      pullRequestCompact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "core-runtime-tui-pty")?.env,
    ).toEqual({
      OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
      OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
      // Timing-sensitive groups pin the worker budget while the job-level
      // default scales with the runner class.
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    expect(
      compact.flatMap((shard) => shard.groups).find((group) => group.shard_name === "agentic-cli")
        ?.env,
    ).toBeUndefined();
    for (const suffix of ["1", "2", "3"]) {
      const groups = compact
        .flatMap((shard) => shard.groups)
        .filter(
          (group) =>
            group.shard_name.replace(/-hosted-\d+$/u, "") === `core-runtime-media-ui-${suffix}`,
        );
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group.env).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
      }
    }
    expect(
      compact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "core-runtime-media-ui-support")?.env,
    ).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
    const startupCoreJob = compact.find((shard) =>
      shard.groups.some((group) => group.shard_name === "agentic-control-plane-startup-core"),
    );
    expect(startupCoreJob?.runner).toBe(
      usesParallelPacking(startupCoreJob) ? EXTRA_LARGE_NODE_TEST_RUNNER : DEFAULT_NODE_TEST_RUNNER,
    );
    expect(
      startupCoreJob?.groups.find(
        (group) => group.shard_name === "agentic-control-plane-startup-core",
      )?.runner,
    ).toBe(DEFAULT_NODE_TEST_RUNNER);
    const startupHealthJob = expectDefined(
      compact.find((job) =>
        job.groups.some(
          (group) => group.shard_name === "agentic-control-plane-startup-health-runtime",
        ),
      ),
      "startup health runtime job",
    );
    const measuredSiblings = startupHealthJob.groups.filter(
      (group) => group.fallbackMaxWorkers === 2,
    );
    expect(
      startupHealthJob.groups.find(
        (group) => group.shard_name === "agentic-control-plane-startup-health-runtime",
      )?.env,
    ).toEqual({
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000",
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    if (measuredSiblings.length > 0) {
      expect(startupHealthJob.planConcurrency).toBe(1);
      expect(startupHealthJob.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
      for (const sibling of measuredSiblings) {
        const isolated = /^agentic-gateway-server-isolated(?:-hosted-\d+)?$/u.test(
          sibling.shard_name,
        );
        expect(sibling.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe(isolated ? "8" : undefined);
      }
    }
    const largeJobs = compact.filter(
      (shard) => !shard.requiresDist && shard.checkName.startsWith("checks-node-compact-large-"),
    );
    const smallJobs = compact.filter(
      (shard) => !shard.requiresDist && shard.checkName.startsWith("checks-node-compact-small-"),
    );
    const extraLargeJobs = compact.filter(
      (shard) => !shard.requiresDist && shard.checkName.startsWith("checks-node-compact-large32-"),
    );
    const distJobs = compact.filter((shard) => shard.requiresDist);
    expect(largeJobs.length).toBeGreaterThan(0);
    expect(smallJobs.length).toBeGreaterThan(0);
    expect(extraLargeJobs).toHaveLength(1);
    expect(distJobs).toHaveLength(1);
    expect(largeJobs.length + smallJobs.length + extraLargeJobs.length + distJobs.length).toBe(
      compact.length,
    );
    expect(
      largeJobs.every(
        (shard) =>
          shard.groups.every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER) ||
          sharesNativeCapacity(shard),
      ),
    ).toBe(true);
    expect(
      smallJobs.every(
        (shard) =>
          shard.groups.every((group) => group.runner === BUNDLED_NODE_TEST_RUNNER) ||
          sharesNativeCapacity(shard),
      ),
    ).toBe(true);
    expect(extraLargeJobs[0]?.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
    for (const shard of [
      ...compact,
      ...pullRequestCompact,
      ...githubCompact,
      ...githubPullRequestCompact,
      ...hybridCompact,
      ...hybridPullRequestCompact,
    ]) {
      for (const group of shard.groups) {
        if (
          !group.configs.some((config) => /vitest\.cli(?:-process)?\.config\.ts$/u.test(config))
        ) {
          continue;
        }
        expect(isExclusiveCompactShardName(group.shard_name)).toBe(true);
        expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe(
          group.shard_name === "agentic-cli" &&
            !githubCompact.includes(shard) &&
            !githubPullRequestCompact.includes(shard)
            ? undefined
            : "2",
        );
        if ((shard.predictedSeconds ?? 0) > 150) {
          if (isCombinedUnbuiltCliJob(shard)) {
            expect([...hybridCompact, ...hybridPullRequestCompact]).toContain(shard);
            expect(shard.predictedSeconds).toBeLessThanOrEqual(250);
          } else if (shard.pretestBuildMode && shard.groups.length > 1) {
            expect([...githubCompact, ...githubPullRequestCompact]).toContain(shard);
            expect(shard).toMatchObject({ planConcurrency: 1, requiresDist: false });
            expect(shard.groups.every((entry) => entry.pretestBuildMode)).toBe(true);
            expect(shard.predictedSeconds).toBeLessThanOrEqual(210);
          } else {
            expect(shard.groups).toHaveLength(1);
          }
        }
      }
    }
    expect(compact).toEqual(
      createNodeTestShardBundles({
        includeReleaseOnlyPluginShards: false,
        compactMode: "push",
      }),
    );
    const embeddedAgentGroups = compact
      .flatMap((shard) => shard.groups)
      .filter((group) => group.shard_name.startsWith("agentic-agents-embedded-"));
    expect(embeddedAgentGroups.map((group) => group.shard_name).toSorted()).toEqual(
      expectedEmbeddedAgentGroupNames,
    );
    expect(
      compact.some((shard) =>
        shard.groups.some((group) => group.shard_name === "agentic-agents-embedded"),
      ),
    ).toBe(false);
    // The base config repeats once per stripe; its files stay partitioned below.
    expect(new Set(embeddedAgentGroups.flatMap((group) => group.configs))).toEqual(
      new Set(embeddedAgentVitestProjectOwners.map((owner) => owner.config)),
    );
    expect(
      embeddedAgentGroups.every(
        (group) => group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS === "660000",
      ),
    ).toBe(true);
    // Base stripes must partition the owner's files: a repeat re-runs a suite,
    // and a missing file silently loses coverage.
    const embeddedBaseGroups = embeddedAgentGroups.filter((group) =>
      /^agentic-agents-embedded-base-\d+$/u.test(group.shard_name),
    );
    const embeddedBaseFiles = embeddedBaseGroups.flatMap((group) => group.includePatterns ?? []);
    expect(embeddedBaseGroups).toHaveLength(3);
    expect(
      embeddedBaseGroups.every(
        (group) => group.configs[0] === agentVitestProjectOwners.embedded.config,
      ),
    ).toBe(true);
    expect(new Set(embeddedBaseFiles).size).toBe(embeddedBaseFiles.length);
    expect(embeddedBaseFiles.toSorted((a, b) => a.localeCompare(b))).toEqual(
      embeddedBaseOwnerFiles.toSorted((a, b) => a.localeCompare(b)),
    );
    expect(
      compact
        .filter((shard) => shard.groups.some((group) => !group.includePatterns))
        .every((shard) => shard.timeoutMinutes === 120),
    ).toBe(true);
    // Whole-config groups now pack into the same runtime-balanced bins as
    // include-pattern groups; the separate "-whole-" job class is gone.
    expect(compact.some((shard) => shard.checkName.includes("-whole-"))).toBe(false);
    expect(
      compact.some((shard) => shard.groups.some((group) => group.shard_name === "core-tooling")),
    ).toBe(false);
    expect(
      pullRequestCompact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "core-tooling-isolated"),
    ).toEqual(
      expect.objectContaining({
        configs: [
          "test/vitest/vitest.tooling-docker.config.ts",
          "test/vitest/vitest.tooling-isolated.config.ts",
        ],
      }),
    );
    // The docker helper config rides with the isolated shard on both plans;
    // no standalone core-tooling-docker group remains.
    expect(
      pullRequestCompact
        .flatMap((shard) => shard.groups)
        .some((group) => group.shard_name === "core-tooling-docker"),
    ).toBe(false);
    const toolingGroups = pullRequestCompactGroups.filter((group) =>
      /^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name),
    );
    const toolingFiles = toolingGroups.flatMap((group) => group.includePatterns ?? []);
    expect(
      new Set(
        [...compactOwnerNames(pullRequestCompact)].filter((name) =>
          /^core-tooling-\d+$/u.test(name),
        ),
      ),
    ).toEqual(new Set(expectedToolingOwnerNames));
    expect(
      toolingGroups.every((group) => group.configs[0] === "test/vitest/vitest.tooling.config.ts"),
    ).toBe(true);
    expect(new Set(toolingFiles).size).toBe(toolingFiles.length);
    expect(toolingFiles.toSorted((a, b) => a.localeCompare(b))).toEqual(listAllToolingTestFiles());
  }
  it.each(plannerHosts)(
    "preserves coverage and execution policies with committed compact measurements ($label)",
    checkCommittedCompactPolicies,
  );

  it("splits the slow core unit shards while keeping paired source/security coverage", () => {
    const coreUnitShards = defaultShards
      .filter((shard) => shard.shardName.startsWith("core-unit-"))
      .map((shard) => ({
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        shardName: shard.shardName,
      }));

    expect(coreUnitShards).toEqual([
      {
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-1",
      },
      {
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-2",
      },
      {
        configs: ["test/vitest/vitest.unit-fast-isolated.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-isolated",
      },
      {
        configs: ["test/vitest/vitest.unit-fast-fake-timers.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-fake-timers",
      },
      {
        configs: ["test/vitest/vitest.unit-src.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-1",
      },
      {
        configs: ["test/vitest/vitest.unit-src.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-2",
      },
      {
        configs: ["test/vitest/vitest.unit-src.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-3",
      },
      {
        configs: ["test/vitest/vitest.unit-security.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-support",
      },
      {
        configs: ["test/vitest/vitest.unit-support.config.ts"],
        requiresDist: false,
        shardName: "core-unit-support",
      },
    ]);
  });

  it("partitions each giant compact group across three deterministic stripes", () => {
    const env = { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: undefined };
    const cases = [
      {
        stripeConfigs: [createUiVitestConfig(env)],
        supportConfigs: [
          createMediaVitestConfig(env),
          createMediaUnderstandingVitestConfig(env),
          createTuiVitestConfig(env),
          createUiIsolatedVitestConfig(env),
          createUiTimingVitestConfig(env),
          createWizardVitestConfig(env),
        ],
        prefix: "core-runtime-media-ui",
      },
      {
        stripeConfigs: [createGatewayCoreVitestConfig(env), createGatewayClientVitestConfig(env)],
        supportConfigs: [],
        prefix: "agentic-gateway-core",
      },
      {
        stripeConfigs: [
          createUnitVitestConfigWithOptions(env, {
            name: "unit-src",
            includePatterns: ["src/**/*.test.ts"],
            extraExcludePatterns: ["src/acp/**", "src/security/**"],
          }),
        ],
        supportConfigs: [
          createUnitVitestConfigWithOptions(env, {
            name: "unit-security",
            includePatterns: ["src/security/**/*.test.ts"],
            passWithNoTests: true,
          }),
        ],
        prefix: "core-unit-src-security",
      },
    ];

    const shards = defaultShards;
    for (const { prefix, stripeConfigs, supportConfigs } of cases) {
      const stripes = shards.filter(
        (shard) => /^.+-\d+$/u.test(shard.shardName) && shard.shardName.startsWith(`${prefix}-`),
      );
      // Files needing a pretest build are pulled into a sibling `-runtime`
      // shard so only one job builds; coverage must still be complete across
      // the stripes plus that shard.
      const coverageShards = shards.filter((shard) => shard.shardName.startsWith(`${prefix}-`));
      const actual = coverageShards
        .flatMap((shard) => shard.includePatterns ?? [])
        .toSorted((a, b) => a.localeCompare(b));
      const expected = stripeConfigs
        .flatMap((config) => listMatchedTestFiles(config))
        .toSorted((a, b) => a.localeCompare(b));

      expect(stripes.map((stripe) => stripe.shardName)).toEqual([
        `${prefix}-1`,
        `${prefix}-2`,
        `${prefix}-3`,
      ]);
      expect(stripes.every((stripe) => (stripe.includePatterns?.length ?? 0) > 0)).toBe(true);
      expect(new Set(actual).size).toBe(actual.length);
      expect(actual).toEqual(expected);

      const support = shards.find((shard) => shard.shardName === `${prefix}-support`);
      if (supportConfigs.length === 0) {
        expect(support).toBeUndefined();
      } else {
        expect(support?.includePatterns).toBeUndefined();
        expect(support?.configs).toHaveLength(supportConfigs.length);
      }
    }
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "runs timing budgets once through their support owner in %s hosted plans",
    (runnerBackend) => {
      const groups = getCommittedCompactPlan("pull-request", runnerBackend).flatMap(
        (job) => job.groups,
      );
      const owners = groups.filter((group) =>
        group.configs.includes("test/vitest/vitest.ui-timing.config.ts"),
      );
      expect(owners).toHaveLength(1);
      expect(owners[0]?.shard_name).toBe("core-runtime-media-ui-support");
      expect(owners[0]?.includePatterns).toBeUndefined();
      const stripedFiles = groups.flatMap((group) => group.includePatterns ?? []);
      for (const file of uiTimingTestFiles) {
        // Shared UI excludes these files; leaving them in its stripes silently skips them.
        expect(stripedFiles).not.toContain(file);
      }
      expect(
        listMatchedTestFiles(
          createUiTimingVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: undefined }),
        ),
      ).toEqual(uiTimingTestFiles);
    },
  );

  it("names the node shard checks as core test lanes", () => {
    const shards = defaultShards;

    expect(shards).not.toHaveLength(0);
    expect(shards.map((shard) => shard.checkName)).toEqual(
      shards.map((shard) =>
        shard.shardName.startsWith("core-unit-")
          ? `checks-node-core-${shard.shardName.slice("core-unit-".length)}`
          : `checks-node-${shard.shardName}`,
      ),
    );
  });

  it("keeps extension, bundled, contracts, and channels configs out of the core node lane", () => {
    const configs = defaultShards.flatMap((shard) => shard.configs);

    expect(configs).not.toContain("test/vitest/vitest.channels.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.contracts.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.bundled.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.extension-telegram.config.ts");
  });

  it("keeps compact agentic config ownership aligned with the full agentic project set", () => {
    const fullAgenticShard = fullSuiteVitestShards.find((shard) => shard.name === "agentic");
    const intentionallyExcludedConfigs = new Set(["test/vitest/vitest.channels.config.ts"]);
    const expectedConfigs = (fullAgenticShard?.projects ?? [])
      .filter((config) => !intentionallyExcludedConfigs.has(config))
      .toSorted((left, right) => left.localeCompare(right));
    const actualConfigs = [
      ...new Set(
        defaultShards
          .filter((shard) => shard.shardName.startsWith("agentic-"))
          .flatMap((shard) => shard.configs),
      ),
    ].toSorted((left, right) => left.localeCompare(right));

    expect(fullAgenticShard).toBeDefined();
    expect(actualConfigs).toEqual(expectedConfigs);
  });

  it("marks only dist-dependent shards for built artifact restore", () => {
    const requiresDistShardNames = defaultShards
      .filter((shard) => shard.requiresDist)
      .map((shard) => shard.shardName);

    expect(requiresDistShardNames).toEqual(["core-support-boundary", "core-runtime-tui-pty"]);
  });

  it("keeps lifecycle proofs on main while excluding PR and manual PR-fallback plans", () => {
    const proofFiles = [
      "src/commands/doctor-config-preflight.refusal.process.test.ts",
      "src/gateway/server.codex-failure-recovery.test.ts",
    ];
    const files = (mode: "push" | "pull-request") =>
      getCommittedCompactPlan(mode).flatMap((shard) =>
        shard.groups.flatMap((group) => group.includePatterns ?? []),
      );
    const mainFiles = files("push");
    const prFiles = files("pull-request");
    const manual = createNodeTestShards({ includeProofTests: false });
    for (const file of proofFiles) {
      expect(mainFiles.filter((target) => target === file)).toHaveLength(1);
      expect(prFiles).not.toContain(file);
      expect(manual.flatMap((shard) => shard.includePatterns ?? [])).not.toContain(file);
    }
    expect(
      manual.find((shard) => shard.shardName === "agentic-gateway-server-isolated")
        ?.includePatterns,
    ).toContain("src/gateway/server.chat-recovered-output.test.ts");
  });

  it("preserves runtime preparation and core-only ownership in full and compact plans", () => {
    const qaConfig = "test/vitest/vitest.extension-qa.config.ts";
    const doctorRuntimeTargets = [
      "src/commands/doctor-config-flow.legacy-composition.test.ts",
      "src/commands/doctor-config-preflight.process.test.ts",
      "src/commands/doctor-config-preflight.refusal.process.test.ts",
      "src/commands/doctor-config-preflight.v17-atomicity.process.test.ts",
    ];
    const runtimeTargets = [
      "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
      "src/infra/update-managed-service-handoff-lifecycle.test.ts",
      ...doctorRuntimeTargets,
      "src/commands/doctor-plugin-install-config.process.test.ts",
      "src/gateway/gateway-active-memory.test.ts",
      "src/gateway/gateway-auth-recovery.test.ts",
      "src/gateway/gateway-concurrent-streams.test.ts",
      "src/gateway/gateway-cron-process-identity.windows.test.ts",
      "src/gateway/gateway-route-model-reuse.test.ts",
      "src/gateway/gateway-ssh-upload-signal.test.ts",
      "src/gateway/server.config-patch.test.ts",
    ];
    const databaseWorkerFiles = new Set(
      listMatchedTestFiles(createGatewayDatabaseWorkersVitestConfig({})),
    );
    const ownsRuntimeTarget = (
      group: { configs: string[]; includePatterns?: string[] },
      file: string,
    ) =>
      group.includePatterns
        ? group.includePatterns.includes(file)
        : group.configs.includes("test/vitest/vitest.gateway-database-workers.config.ts") &&
          databaseWorkerFiles.has(file);
    const full = defaultShards;
    const compact = createNodeTestShardBundles({ compact: true, compactMode: "pull-request" });
    for (const shards of [full, compact]) {
      expect(
        shards.flatMap((shard) =>
          "configs" in shard ? shard.configs : shard.groups.flatMap((group) => group.configs),
        ),
      ).not.toContain(qaConfig);
      for (const runtimeTarget of [...runtimeTargets, PRIVATE_QA_TOOLING_TEST]) {
        if (shards === compact && isCiProofTestFile(runtimeTarget)) {
          expect(
            compact
              .flatMap((shard) => shard.groups)
              .some((group) => ownsRuntimeTarget(group, runtimeTarget)),
          ).toBe(false);
          continue;
        }
        const owner = expectDefined(
          shards.find((shard) =>
            ("configs" in shard ? [shard] : shard.groups).some((group) =>
              ownsRuntimeTarget(group, runtimeTarget),
            ),
          ),
          `runtime owner for ${runtimeTarget}`,
        );
        const groups = "configs" in owner ? [owner] : owner.groups;
        // A shared build takes the strongest requirement of its complete selection.
        const containsPrivateQa = groups.some((group) =>
          group.includePatterns?.includes(PRIVATE_QA_TOOLING_TEST),
        );
        expect(owner.pretestBuildMode, runtimeTarget).toBe(
          containsPrivateQa ? "private-qa" : "runtime",
        );
        const group = groups.find((entry) => ownsRuntimeTarget(entry, runtimeTarget));
        expect(group?.pretestBuildMode, runtimeTarget).toBe(
          group?.includePatterns?.includes(PRIVATE_QA_TOOLING_TEST) ? "private-qa" : "runtime",
        );
      }
    }

    const doctorName = "agentic-commands-doctor-config-state";
    const doctor = full.find((shard) => shard.shardName === doctorName)!;
    const placements = compact.flatMap((job, jobIndex) =>
      job.groups
        .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === doctorName)
        .map((group) => ({ group, job, jobIndex })),
    );
    const commandRuntime = compact
      .flatMap((job) => job.groups)
      .filter((group) => group.shard_name === "agentic-commands-runtime");
    expect(commandRuntime).toHaveLength(1);
    expect(commandRuntime[0]?.pretestBuildMode).toBe("runtime");
    expect(commandRuntime[0]?.includePatterns?.toSorted()).toEqual(
      [...doctorRuntimeTargets, "src/commands/doctor-plugin-install-config.process.test.ts"]
        .filter((file) => !isCiProofTestFile(file))
        .toSorted(),
    );
    expect(placements.every(({ group }) => group.pretestBuildMode === undefined)).toBe(true);
    expect(placements.flatMap(({ group }) => group.includePatterns ?? []).toSorted()).toEqual(
      doctor.includePatterns?.filter((file) => !isCiProofTestFile(file)).toSorted(),
    );
    expect(new Set(placements.map(({ jobIndex }) => jobIndex)).size).toBe(placements.length);
    for (const { group } of placements) {
      expect(group.configs).toEqual(doctor.configs);
      expect(group.env).toEqual(doctor.env);
      expect(group.fallbackMaxWorkers).toBe(2);
      expect(group.requiresDist).toBe(doctor.requiresDist);
      expect(group.runner).toBe(BUNDLED_NODE_TEST_RUNNER);
    }
  });

  it("splits tooling checks independently from built artifacts", () => {
    const compilerFixture = "test/scripts/write-unified-entry-dts.test.ts";
    const toolingShards = defaultShards.filter((shard) =>
      shard.shardName.startsWith("core-tooling"),
    );
    const compilerParent = toolingShards.find((shard) =>
      shard.includePatterns?.includes(compilerFixture),
    )!;
    for (const runnerBackend of ["blacksmith", "hybrid", "github"]) {
      const jobs = getCommittedCompactPlan("pull-request", runnerBackend);
      const owner = jobs.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(compilerFixture)),
      );
      // This fixture runs the real full-build guard, which needs more than the
      // available heap observed inside a small runner's retained tooling graph.
      expect(owner?.runner, runnerBackend).toBe(
        runnerBackend === "github" ? DEFAULT_NODE_TEST_RUNNER : EXTRA_LARGE_NODE_TEST_RUNNER,
      );
      const precise = createSelectedNodeTestShardBundles([compilerFixture], { runnerBackend });
      const preciseOwner = precise?.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(compilerFixture)),
      );
      expect(preciseOwner?.runner, runnerBackend).toBe(owner?.runner);
      expect(preciseOwner?.planConcurrency).toBe(1);
      expect(preciseOwner?.groups).toEqual([
        expect.objectContaining({
          includePatterns: [compilerFixture],
          env: expect.objectContaining({ OPENCLAW_VITEST_MAX_WORKERS: "2" }),
        }),
      ]);
      expect(
        jobs
          .flatMap((job) => job.groups)
          .filter((group) => group.includePatterns?.includes(compilerFixture)),
      ).toHaveLength(1);
      if (runnerBackend !== "blacksmith") {
        const siblings = jobs
          .flatMap((job) => job.groups)
          .filter(
            (group) =>
              group.shard_name.startsWith(`${compilerParent.shardName}-hosted-`) &&
              !group.includePatterns?.includes(compilerFixture),
          );
        expect(siblings.length).toBeGreaterThan(0);
        expect(siblings.every((group) => group.runner === BUNDLED_NODE_TEST_RUNNER)).toBe(true);
      }
    }

    const sdkFixture = "test/scripts/write-plugin-sdk-entry-dts.test.ts";
    for (const runnerBackend of ["blacksmith", "hybrid", "github"]) {
      const sdkJobs = createSelectedNodeTestShardBundles([sdkFixture], { runnerBackend });
      const fullOwner = getCommittedCompactPlan("pull-request", runnerBackend).find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(sdkFixture)),
      );
      const selectedOwner = sdkJobs?.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(sdkFixture)),
      );
      for (const owner of [fullOwner, selectedOwner]) {
        expect(owner?.runner, runnerBackend).toBe(
          runnerBackend === "github" ? BUNDLED_NODE_TEST_RUNNER : EXTRA_LARGE_NODE_TEST_RUNNER,
        );
        expect(owner?.planConcurrency).toBe(1);
      }
      expect(selectedOwner?.groups).toEqual([
        expect.objectContaining({
          includePatterns: [sdkFixture],
          env: expect.objectContaining({ OPENCLAW_VITEST_MAX_WORKERS: "2" }),
        }),
      ]);
    }

    const stripes = toolingShards.filter((shard) => /^core-tooling-\d+$/u.test(shard.shardName));
    expect(stripes).toHaveLength(16);
    for (const stripe of stripes) {
      expect(stripe.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
      expect(stripe.requiresDist).toBe(false);
      expect(stripe.includePatterns?.length ?? 0).toBeGreaterThan(0);
    }
    // Stripes partition the tooling files: no overlap, nothing dropped.
    const stripeFiles = stripes.flatMap((stripe) => stripe.includePatterns ?? []);
    expect(new Set(stripeFiles).size).toBe(stripeFiles.length);
    const processProofFiles = [
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/managed-child-process.test.ts",
      "test/scripts/vitest-worker-artifacts.test.ts",
      "test/scripts/vitest-worker-artifacts.transforms.test.ts",
      "test/scripts/openclaw-performance-git-lifecycle.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/pr-merge-outcome.test.ts",
    ];
    const processProofStripes = processProofFiles.map(
      (file) => stripes.find((stripe) => stripe.includePatterns?.includes(file))?.shardName,
    );
    expect(processProofStripes).not.toContain(undefined);
    expect(new Set(processProofStripes).size).toBe(processProofFiles.length);
    const runtimeStripe = stripes.find((stripe) =>
      stripe.includePatterns?.includes(
        "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
      ),
    );
    expect(runtimeStripe?.pretestBuildMode).toBe(
      runtimeStripe?.includePatterns?.includes(PRIVATE_QA_TOOLING_TEST) ? "private-qa" : "runtime",
    );
    expect(
      toolingShards.find((shard) => shard.shardName === "core-tooling-isolated"),
    ).toMatchObject({
      configs: [
        "test/vitest/vitest.tooling-docker.config.ts",
        "test/vitest/vitest.tooling-isolated.config.ts",
      ],
      requiresDist: false,
    });
  });

  it("keeps non-tooling placement checks independent of singleton tooling split names", () => {
    const anchor: CompactNodeTestShard = {
      checkName: "checks-node-compact-small-1",
      shardName: "compact-small-1",
      runner: BUNDLED_NODE_TEST_RUNNER,
      requiresDist: false,
      planConcurrency: 1,
      groups: [
        {
          shard_name: "core-unit-fast",
          configs: ["test/vitest/vitest.unit-fast.config.ts"],
          requiresDist: false,
          runner: BUNDLED_NODE_TEST_RUNNER,
        },
      ],
    };
    // Projection fixture from the real six-file inventory proof: the 330-second
    // file stays alone with the same execution policy when its stripe is named.
    const unsplit: CompactNodeTestShard = {
      ...anchor,
      checkName: "checks-node-compact-small-22",
      shardName: "compact-small-22",
      predictedSeconds: 330,
      groups: [
        {
          shard_name: "core-tooling-1",
          configs: ["test/vitest/vitest.tooling.config.ts"],
          includePatterns: ["test/scripts/pr-merge-outcome.test.ts"],
          requiresDist: false,
          runner: BUNDLED_NODE_TEST_RUNNER,
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        },
      ],
    };
    const split: CompactNodeTestShard = {
      ...unsplit,
      checkName: "checks-node-compact-small-33",
      shardName: "compact-small-33",
      groups: [{ ...unsplit.groups[0]!, shard_name: "core-tooling-1-hosted-1" }],
    };
    const original = structuredClone({ anchor, unsplit, split });
    const expected = [
      {
        groups: ["core-unit-fast"],
        planConcurrency: 1,
        pretestBuildMode: undefined,
        requiresDist: false,
        runner: BUNDLED_NODE_TEST_RUNNER,
      },
    ];
    expect(nonToolingPlacement([anchor, unsplit])).toEqual(expected);
    expect(nonToolingPlacement([anchor, split])).toEqual(expected);
    expect(nonToolingPlacement([split])).not.toEqual(expected);
    for (const changed of [
      { ...anchor, runner: DEFAULT_NODE_TEST_RUNNER },
      { ...anchor, planConcurrency: 2 },
      { ...anchor, requiresDist: true },
      { ...anchor, pretestBuildMode: "runtime" as const },
    ]) {
      expect(nonToolingPlacement([changed, split])).not.toEqual(expected);
    }
    expect({ anchor, unsplit, split }).toEqual(original);
  });

  it("keeps precise tooling selection through hosted overflow refusal", () => {
    const tooling = defaultShards.filter((shard) => /^core-tooling-\d+$/u.test(shard.shardName));
    const selected = tooling.flatMap((shard) => shard.includePatterns ?? []).slice(0, 96);
    expect(selected).toHaveLength(96);
    vi.spyOn(shardMetadata, "estimateVitestToolingFileSeconds").mockReturnValue(20_000);
    // Every selected file is now indivisible above the admission cap. Overflow
    // must retain these 96 files plus two dist owners, never resurrect the full suite.
    expect(() => createSelectedNodeTestShardBundles(selected, { runnerBackend: "github" })).toThrow(
      "exceeds 90 jobs (98 planned)",
    );
  });

  it("keeps the private runtime prerequisite on precise tooling readers", () => {
    const shards = createSelectedNodeTestShardBundles([PRIVATE_QA_TOOLING_TEST]);
    expect(shards).not.toBeNull();
    const readers = shards?.filter((shard) => !shard.requiresDist) ?? [];
    expect(readers).toHaveLength(1);
    expect(readers[0]?.pretestBuildMode).toBe("private-qa");
    expect(readers[0]?.planConcurrency).toBe(1);
    expect(readers[0]?.groups.flatMap((group) => group.includePatterns ?? [])).toEqual([
      PRIVATE_QA_TOOLING_TEST,
    ]);
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "runs large workspace inventory without sibling files in %s plans",
    (runnerBackend) => {
      const inventory = "src/gateway/worker-environments/workspace-large-inventory.test.ts";
      const owners = defaultShards.filter((shard) => shard.includePatterns?.includes(inventory));
      expect(owners).toHaveLength(1);
      expect(owners[0]!.includePatterns).toEqual([inventory]);

      for (const plan of [
        getCommittedCompactPlan("pull-request", runnerBackend),
        getCommittedCompactPlan("push", runnerBackend),
      ]) {
        const jobs = plan.filter((job) =>
          job.groups.some((group) => group.includePatterns?.includes(inventory)),
        );
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.planConcurrency).toBe(1);
        const groups = jobs[0]!.groups.filter((group) =>
          group.includePatterns?.includes(inventory),
        );
        expect(groups).toHaveLength(1);
        expect(groups[0]!.includePatterns).toEqual([inventory]);
        expect(groups[0]!.configs).toEqual(["test/vitest/vitest.gateway-core.config.ts"]);
      }
    },
  );

  it.each([
    { name: "Blacksmith", runnerBackend: undefined, measured: true },
    { name: "hybrid", runnerBackend: "hybrid", measured: true },
    { name: "GitHub-hosted", runnerBackend: "github", measured: false },
  ])("retains whole CLI worker and process policies on $name", ({ runnerBackend, measured }) => {
    pinPlannerHost(plannerHosts[0]);
    for (const compactMode of ["push", "pull-request"] as const) {
      const plan = getCommittedCompactPlan(compactMode, runnerBackend);
      const groups = plan.flatMap((job) => job.groups);
      const cliGroups = groups.filter((group) => group.shard_name === "agentic-cli");
      expect(cliGroups).toHaveLength(1);
      const cli = cliGroups[0]!;
      expect(cli.configs).toEqual(["test/vitest/vitest.cli.config.ts"]);
      expect(cli.includePatterns).toBeUndefined();
      expect(cli.timing_key).toBeUndefined();
      expect(cli.env).toEqual(measured ? undefined : { OPENCLAW_VITEST_MAX_WORKERS: "2" });
      expect(cli.fallbackMaxWorkers).toBe(measured ? 2 : undefined);
      const job = expectDefined(
        plan.find((entry) => entry.groups.includes(cli)),
        "full CLI job",
      );
      expect(job.planConcurrency).toBe(1);
      expect(job.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
      if (measured) {
        expect(job.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
      }
      const processGroups = groups.filter((group) =>
        group.configs.includes("test/vitest/vitest.cli-process.config.ts"),
      );
      expect(processGroups.length).toBeGreaterThan(0);
      for (const group of processGroups) {
        expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        expect(group.fallbackMaxWorkers).toBeUndefined();
      }
    }
  });

  it.each(
    ["blacksmith", "github", "hybrid"].flatMap((runnerBackend) =>
      ["agentic-gateway-core-2", "agentic-cli"].map((owner) => ({ runnerBackend, owner })),
    ),
  )(
    "retains $owner worker fallback in precise $runnerBackend plans",
    ({ runnerBackend, owner }) => {
      const shard = expectDefined(
        defaultShards.find((entry) => entry.shardName === owner),
        `${owner} owner`,
      );
      const target =
        owner === "agentic-cli"
          ? "src/cli/nodes-cli.coverage.test.ts"
          : expectDefined(
              shard.includePatterns?.find((file) =>
                file.startsWith("packages/gateway-client/src/"),
              ),
              "precisely routed core-2 client target",
            );
      const plan = expectDefined(
        createSelectedNodeTestShardBundles([target], { runnerBackend }),
        `precise ${owner} plan`,
      );
      const groups = plan.flatMap((job) => job.groups);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.configs).toEqual(shard.configs);
      if (owner === "agentic-cli") {
        expect(groups[0]!.shard_name).toBe(owner);
      }
      expect(groups[0]!.includePatterns).toEqual([target]);
      expect(groups[0]!.fallbackMaxWorkers).toBe(runnerBackend === "github" ? undefined : 2);
      expect(groups[0]!.env).toEqual(
        runnerBackend === "github" ? { OPENCLAW_VITEST_MAX_WORKERS: "2" } : undefined,
      );
      expect(plan.map((job) => job.planConcurrency)).toEqual([1]);
      if (owner === "agentic-cli" && runnerBackend !== "github") {
        expect(plan.map((job) => job.runner)).toEqual([EXTRA_LARGE_NODE_TEST_RUNNER]);
      }
    },
  );

  it.each(["blacksmith", "github", "hybrid"])(
    "shares one prepared runtime across affordable %s tooling groups",
    (runnerBackend) => {
      const targets = [
        PRIVATE_QA_TOOLING_TEST,
        "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
      ];
      vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(
        Object.fromEntries(defaultShards.map((shard) => [shard.shardName, 1])),
      );
      const plan = createSelectedNodeTestShardBundles(targets, { runnerBackend });
      expect(plan).not.toBeNull();
      const readers = plan!.filter((shard) => !shard.requiresDist);
      expect(readers).toHaveLength(1);
      expect(readers[0]).toMatchObject({ pretestBuildMode: "private-qa", planConcurrency: 1 });
      expect(readers[0]!.predictedSeconds).toBeLessThanOrEqual(
        runnerBackend === "github" ? 210 : 150,
      );
      expect(readers[0]!.groups.every((group) => group.pretestBuildMode)).toBe(true);
      expect(readers[0]!.groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        targets.toSorted(),
      );
    },
  );

  it("packs serial groups within both the time and group-count budgets", () => {
    const groups = [34, 33, 33, 32, 32, 32, 10, 21, 17, 17, 15, 10, 8, 7, 7, 7, 6, 5, 5];
    const bins = packNodeTestGroups(
      groups,
      (bin, group) => bin.length < 10 && bin.reduce((sum, value) => sum + value, group) <= 210,
      true,
    );
    expect(bins).toHaveLength(2);
    expect(bins.flat().toSorted((a, b) => a - b)).toEqual(groups.toSorted((a, b) => a - b));
    for (const bin of bins) {
      expect(bin.length).toBeLessThanOrEqual(10);
      expect(bin.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(210);
    }
  });

  it.each(["runner", "dist", "preparation"] as const)(
    "keeps group exchanges within the owner's %s boundary",
    (boundary) => {
      const groups = [144, 120, 72, 48, 48, 48].map((seconds, index) => ({
        index,
        seconds,
        runner: boundary === "runner" && index === 2 ? "other" : "shared",
        requiresDist: boundary === "dist" && index === 2,
        preparation: boundary === "preparation" && index === 2,
      }));
      const bins = packNodeTestGroups(
        groups,
        (bin, group) =>
          !group.preparation &&
          bin.every(
            (entry) =>
              !entry.preparation &&
              entry.runner === group.runner &&
              entry.requiresDist === group.requiresDist,
          ) &&
          bin.reduce((sum, entry) => sum + entry.seconds, group.seconds) <= 240,
        true,
      );
      expect(bins).toHaveLength(3);
      expect(bins.flat().toSorted((a, b) => a.index - b.index)).toEqual(groups);
      expect(bins.find((bin) => bin.some((group) => group.index === 2))).toEqual([groups[2]]);
      for (const bin of bins) {
        expect(bin.reduce((sum, group) => sum + group.seconds, 0)).toBeLessThanOrEqual(240);
      }
    },
  );

  async function createToolingFixturePlan(params: {
    files: string[];
    shards: typeof fullSuiteVitestShards;
    timings: Record<string, number>;
    fileSeconds: (file: string) => number;
    options: {
      compactMode: "pull-request";
      runnerBackend: string;
      includeReleaseOnlyPluginShards: false;
      compactNodeJobCap?: number;
    };
  }) {
    const unitFastPaths = await vi.importActual<
      typeof import("../vitest/vitest.unit-fast-paths.mjs")
    >("../vitest/vitest.unit-fast-paths.mjs");
    vi.resetModules();
    vi.doMock("../vitest/vitest.unit-fast-paths.mjs", () => ({
      ...unitFastPaths,
      getUnitFastTestFiles: () => [],
      getUnitFastIsolatedTestFiles: () => [],
      getUnitFastTimerTestFiles: () => [],
      getUnitFastTestFilesForIncludePatterns: () => [],
    }));
    vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
      fullSuiteVitestShards: params.shards,
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
      ...testTimings,
      readCompactGroupTimings: () => params.timings,
    }));
    vi.doMock("../../scripts/lib/vitest-shard-metadata.mts", () => ({
      ...shardMetadata,
      estimateVitestToolingFileSeconds: params.fileSeconds,
    }));
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (rootDir: string) =>
        rootDir === "test" ? params.files.toSorted() : [],
    }));
    try {
      const { createNodeTestShardBundles: createPlan } =
        await import("../../scripts/lib/ci-node-test-plan.mts");
      return createPlan(params.options);
    } finally {
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/vitest-shard-metadata.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.doUnmock("../vitest/vitest.unit-fast-paths.mjs");
      vi.resetModules();
    }
  }

  it.each([
    { profile: "blacksmith", expectedSeconds: 840, whaleSeconds: 200 },
    { profile: "hybrid", expectedSeconds: 840, whaleSeconds: 200 },
    { profile: "github", expectedSeconds: 1_344, whaleSeconds: 320 },
  ])(
    "prices parallel tooling files without dividing the slowest file in $profile",
    async ({ profile, expectedSeconds, whaleSeconds }) => {
      const whale = "test/scripts/fixture-whale.test.ts";
      const files = [
        ...Array.from({ length: 64 }, (_, index) => `test/scripts/fixture-${index}.test.ts`),
        whale,
      ];
      const params = {
        files,
        shards: [
          {
            config: "test/vitest/vitest.full-core-tooling.config.ts",
            name: "core-tooling",
            projects: ["test/vitest/vitest.tooling.config.ts"],
          },
        ],
        timings: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [`core-tooling-${index + 1}`, 20_000]),
        ),
        fileSeconds: (file: string) => (file === whale ? 200 : 20),
        options: {
          compactMode: "pull-request" as const,
          runnerBackend: profile,
          includeReleaseOnlyPluginShards: false as const,
        },
      };
      const plan = await createToolingFixturePlan(params);
      expect(
        plan
          .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
          .toSorted(),
      ).toEqual(files.toSorted());
      expect(
        plan.every(
          (job) =>
            job.planConcurrency === 1 &&
            job.groups.every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2"),
        ),
      ).toBe(true);
      // Sixty-four 20-second files share two workers; the 200-second file stays indivisible.
      expect(plan.reduce((seconds, job) => seconds + job.predictedSeconds!, 0)).toBe(
        expectedSeconds,
      );
      expect(
        plan.find((job) => job.groups.some((group) => group.includePatterns?.includes(whale)))
          ?.predictedSeconds,
      ).toBe(whaleSeconds);
      for (const group of plan.flatMap((job) => job.groups)) {
        if (group.timing_key) {
          params.timings[group.timing_key] = 20_000;
        }
      }
      expect(await createToolingFixturePlan(params)).toEqual(plan);
    },
  );

  it("shares a small hosted tooling tail without lowering its runner owner", async () => {
    const compiler = "test/scripts/write-unified-entry-dts.test.ts";
    const shortFiles = ["test/scripts/fixture-short.test.ts"];
    const fileSeconds = new Map<string, number>([
      ...Array.from(
        { length: 32 },
        (_, index) => [`test/scripts/fixture-long-${index}.test.ts`, 300] as const,
      ),
      [compiler, 74],
      [shortFiles[0]!, 10],
    ]);
    const files = [...fileSeconds.keys()];
    const plan = await createToolingFixturePlan({
      files,
      shards: [
        {
          config: "test/vitest/vitest.full-core-tooling.config.ts",
          name: "core-tooling",
          projects: ["test/vitest/vitest.tooling.config.ts"],
        },
      ],
      timings: {},
      fileSeconds: (file) => fileSeconds.get(file)!,
      options: {
        compactMode: "pull-request",
        runnerBackend: "github",
        includeReleaseOnlyPluginShards: false,
      },
    });
    // The compiler child costs 118.4s and the separate 10s file costs 16s on hosted.
    // Their 135s job must retain the compiler's stronger runner and serial children.
    const shared = plan.filter((job) => job.groups.some((group) => group.runner !== job.runner));
    expect(shared).toHaveLength(1);
    const job = shared[0]!;
    expect(job).toMatchObject({
      runner: DEFAULT_NODE_TEST_RUNNER,
      predictedSeconds: 135,
      requiresDist: false,
      planConcurrency: 1,
    });
    expect(job.pretestBuildMode).toBeUndefined();
    expect(job.groups.map((group) => group.runner)).toEqual([
      DEFAULT_NODE_TEST_RUNNER,
      BUNDLED_NODE_TEST_RUNNER,
    ]);
    expect(
      job.groups.every(
        (group) =>
          group.pretestBuildMode === undefined &&
          /^core-tooling-\d+-hosted-\d+$/u.test(group.shard_name),
      ),
    ).toBe(true);
    expect(
      new Set(job.groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, ""))).size,
    ).toBe(2);
    expect(job.groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
      [compiler, ...shortFiles].toSorted(),
    );
    expect(
      plan
        .flatMap((entry) => entry.groups.flatMap((group) => group.includePatterns ?? []))
        .toSorted(),
    ).toEqual(files.toSorted());
  });

  it("keeps hosted tooling within the GitHub job cap when its inventory grows", async () => {
    // Sixty-six full-budget anchors leave 24 of the 90 jobs for tooling.
    const anchors = Array.from({ length: 66 }, (_, index) => ({
      config: `test/vitest/vitest.capacity-anchor-${index}.config.ts`,
      name: `capacity-anchor-${index}`,
      projects: [`test/vitest/vitest.capacity-anchor-${index}.config.ts`],
    }));
    const fixtureShards = [
      ...anchors,
      {
        config: "test/vitest/vitest.full-core-tooling.config.ts",
        name: "core-tooling",
        projects: ["test/vitest/vitest.tooling.config.ts"],
      },
    ];
    // Ten files per tooling family exercise full stripes and packable tails; the compiler
    // fixture puts a stronger runner in a tail that can absorb smaller families.
    const fixtureFiles = [
      ...Array.from(
        { length: 160 },
        (_, index) => `test/scripts/fixture-${String(index).padStart(3, "0")}.test.ts`,
      ),
      "test/scripts/write-unified-entry-dts.test.ts",
    ];
    const fixtureTimings = Object.fromEntries([
      ...anchors.map(({ name }): [string, number] => [name, 210]),
      ...Array.from({ length: 16 }, (_, index): [string, number] => [
        `core-tooling-${index + 1}`,
        200,
      ]),
    ]);
    const options = {
      compactMode: "pull-request",
      runnerBackend: "github",
      includeReleaseOnlyPluginShards: false,
    } as const;
    const inventoryGrowthFile = "test/scripts/resolve-fs-safe-native-contract.test.ts";
    const extraInventories = [
      ["test/scripts/npm-package-locks-report.test.ts"],
      Array.from({ length: 10 }, (_, index) => `test/scripts/zz-growth-probe-${index}.test.ts`),
      ["test/scripts/openclaw-performance-crabbox.test.ts"],
      ["test/scripts/install-smoke-ref-admission.test.ts"],
      [
        "test/scripts/npm-package-locks-report.test.ts",
        "test/scripts/openclaw-performance-crabbox.test.ts",
        "test/scripts/install-smoke-ref-admission.test.ts",
      ],
    ];
    const isHostedToolingGroup = (group: { shard_name: string }) =>
      /^core-tooling-\d+-hosted-\d+$/u.test(group.shard_name);
    const runnerRanks = new Map([
      [BUNDLED_NODE_TEST_RUNNER, 0],
      [DEFAULT_NODE_TEST_RUNNER, 1],
      [EXTRA_LARGE_NODE_TEST_RUNNER, 2],
    ]);
    const measuredFixtureFiles = new Set(fixtureFiles);
    const shorterFixtureFiles = new Set(fixtureFiles.slice(0, 64));
    const createPlanWithInventory = async (
      includeGrowthFile: boolean,
      extraFiles: string[] = [],
      compactNodeJobCap?: number,
      shortFileSeconds = 23,
    ) => {
      return createToolingFixturePlan({
        files: [
          ...fixtureFiles,
          ...extraFiles,
          ...(includeGrowthFile ? [inventoryGrowthFile] : []),
        ],
        shards: fixtureShards,
        timings: fixtureTimings,
        // Mixed file costs fill 90 jobs but leave a feasible donation at the tighter cap.
        // New files retain the cold fallback.
        fileSeconds: (file) =>
          file === "test/scripts/write-unified-entry-dts.test.ts"
            ? 74
            : shorterFixtureFiles.has(file)
              ? shortFileSeconds
              : measuredFixtureFiles.has(file)
                ? 25
                : shardMetadata.estimateVitestToolingFileSeconds(file),
        options: { ...options, compactNodeJobCap },
      });
    };
    const baseline = await createPlanWithInventory(false);
    const baselineToolingFiles = baseline
      .flatMap((job) => job.groups)
      .filter(isNumberedToolingGroup)
      .flatMap((group) => group.includePatterns ?? []);
    expect(baseline).toHaveLength(90);
    expect(baselineToolingFiles.toSorted()).toEqual(fixtureFiles.toSorted());
    const grown = await createPlanWithInventory(true);
    const toolingGroups = grown.flatMap((job) => job.groups).filter(isNumberedToolingGroup);
    const toolingFiles = toolingGroups.flatMap((group) => group.includePatterns ?? []);

    expect(grown.length).toBeLessThanOrEqual(90);
    expect(new Set(toolingFiles).size).toBe(toolingFiles.length);
    expect(toolingFiles.toSorted()).toEqual(
      [...baselineToolingFiles, inventoryGrowthFile].toSorted(),
    );
    expect(nonToolingPlacement(grown)).toEqual(nonToolingPlacement(baseline));

    const budgeted = await createPlanWithInventory(true, [], 89);
    expect(budgeted.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(89);
    expect(nonToolingPlacement(budgeted)).toEqual(nonToolingPlacement(grown));
    expect(
      budgeted
        .flatMap((job) => job.groups)
        .filter(isNumberedToolingGroup)
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted(),
    ).toEqual(toolingFiles.toSorted());

    // At 25s per file, 23 tooling jobs can hold only 158 ordinary files beside
    // the compiler. Preserve refusal of that infeasible 160-file workload.
    await expect(createPlanWithInventory(true, [], 89, 25)).rejects.toThrow(
      "compact github node test plan exceeds 89 jobs",
    );

    for (const job of grown) {
      const hostedToolingGroups = job.groups.filter(isHostedToolingGroup);
      if (hostedToolingGroups.length === 0) {
        continue;
      }
      const families = hostedToolingGroups.map((group) =>
        group.shard_name.replace(/-hosted-\d+$/u, ""),
      );
      expect(new Set(families).size).toBe(families.length);
      expect(job.requiresDist).toBe(false);
      expect(job.planConcurrency).toBe(1);
      expect(job.groups.length).toBeLessThanOrEqual(10);
      if (job.groups.length > 1) {
        expect(job.predictedSeconds).toBeLessThanOrEqual(job.pretestBuildMode ? 210 : 150);
        if (job.pretestBuildMode) {
          expect(job.groups.every((group) => group.pretestBuildMode)).toBe(true);
        }
      }
      expect(job.runner).toBe(job.groups[0]?.runner);
      expect(
        hostedToolingGroups.every(
          (group) => (runnerRanks.get(job.runner) ?? -1) >= (runnerRanks.get(group.runner) ?? 0),
        ),
      ).toBe(true);
      if (hostedToolingGroups.some((group) => group.runner !== job.runner)) {
        expect(job.groups.every(isHostedToolingGroup)).toBe(true);
        expect(job.pretestBuildMode).toBeUndefined();
        expect(job.groups.every((group) => group.pretestBuildMode === undefined)).toBe(true);
      }
    }
    for (const extraFiles of extraInventories) {
      const extraBaseline = await createPlanWithInventory(false, extraFiles);
      const expanded = await createPlanWithInventory(true, extraFiles);
      const expandedToolingFiles = expanded
        .flatMap((job) => job.groups)
        .filter(isNumberedToolingGroup)
        .flatMap((group) => group.includePatterns ?? []);
      expect(expanded.length).toBeLessThanOrEqual(90);
      expect(new Set(expandedToolingFiles).size).toBe(expandedToolingFiles.length);
      expect(expandedToolingFiles.toSorted()).toEqual(
        [...new Set([...baselineToolingFiles, inventoryGrowthFile, ...extraFiles])].toSorted(),
      );
      expect(nonToolingPlacement(extraBaseline)).toEqual(nonToolingPlacement(baseline));
      expect(nonToolingPlacement(expanded)).toEqual(nonToolingPlacement(extraBaseline));
      for (const job of expanded.filter((candidate) =>
        candidate.groups.some(isHostedToolingGroup),
      )) {
        const families = job.groups
          .filter(isHostedToolingGroup)
          .map((group) => group.shard_name.replace(/-hosted-\d+$/u, ""));
        expect(new Set(families).size).toBe(families.length);
        expect(job.requiresDist).toBe(false);
        expect(job.planConcurrency).toBe(1);
        expect(job.groups.length).toBeLessThanOrEqual(10);
        if (job.groups.length > 1) {
          expect(job.predictedSeconds).toBeLessThanOrEqual(job.pretestBuildMode ? 210 : 150);
          if (job.pretestBuildMode) {
            expect(job.groups.every((group) => group.pretestBuildMode)).toBe(true);
          }
        }
        expect(job.runner).toBe(job.groups[0]?.runner);
        expect(
          job.groups.every(
            (group) => (runnerRanks.get(job.runner) ?? -1) >= (runnerRanks.get(group.runner) ?? 0),
          ),
        ).toBe(true);
      }
    }
  });

  it("assigns Blacksmith runners to every core node shard", () => {
    const shards = defaultShards;

    expect(shards).not.toHaveLength(0);
    expect(shards.every((shard) => shard.runner?.startsWith("blacksmith-"))).toBe(true);
  });

  it("splits core runtime configs into smaller source-only shards", () => {
    const runtimeShards = defaultShards
      .filter((shard) => shard.shardName.startsWith("core-runtime-"))
      .map((shard) => ({
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        runner: shard.runner,
        shardName: shard.shardName,
      }));

    expect(runtimeShards).toEqual([
      {
        configs: ["test/vitest/vitest.hooks.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-hooks",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-approval-exec",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-channel-plugin",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-cli-ui",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-device",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-diagnostics-state",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-core-utils",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-env-auth",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-events-runtime",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-file-safety",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-files-commands",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-lock-argv",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-processes",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-watch",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-heartbeat-core",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-heartbeat-runner",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-dedupe-disk",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-os",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-values",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-net-install",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-network-node",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-network-platform",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-outbound-actions",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-outbound-core",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-provider-push",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-repo-tooling",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-storage-state",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-system-runtime",
      },
      {
        configs: ["test/vitest/vitest.secrets.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-secrets",
      },
      {
        configs: ["test/vitest/vitest.logging.config.ts", "test/vitest/vitest.process.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-process",
      },
      {
        configs: ["test/vitest/vitest.runtime-config.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-config",
      },
      {
        configs: ["test/vitest/vitest.tui-pty.config.ts"],
        requiresDist: true,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-tui-pty",
      },
      {
        configs: ["test/vitest/vitest.ui.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-1",
      },
      {
        configs: ["test/vitest/vitest.ui.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-2",
      },
      {
        configs: ["test/vitest/vitest.ui.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-3",
      },
      {
        configs: [
          "test/vitest/vitest.media.config.ts",
          "test/vitest/vitest.media-understanding.config.ts",
          "test/vitest/vitest.tui.config.ts",
          "test/vitest/vitest.ui-isolated.config.ts",
          "test/vitest/vitest.ui-timing.config.ts",
          "test/vitest/vitest.wizard.config.ts",
        ],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-support",
      },
      {
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-shared",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-parallel-core",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-parallel-isolated-agent",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-parallel-service",
      },
    ]);
  });

  it("keeps the full TUI PTY suite in its dedicated built-CLI shard", () => {
    const tuiPtyShard = defaultShards.find((shard) => shard.shardName === "core-runtime-tui-pty");

    expect(tuiPtyShard).toMatchObject({
      checkName: "checks-node-core-runtime-tui-pty",
      configs: ["test/vitest/vitest.tui-pty.config.ts"],
      env: {
        OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
        OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
      },
      requiresDist: true,
    });
    expect(tuiPtyShard?.includePatterns).toBeUndefined();
  });

  it("covers every infra test exactly once across core runtime infra shards", () => {
    const infraShards = defaultShards.filter((shard) =>
      shard.shardName.startsWith("core-runtime-infra-"),
    );
    const actual = infraShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(infraShards.map((shard) => shard.shardName)).toEqual([
      "core-runtime-infra-approval-exec",
      "core-runtime-infra-channel-plugin",
      "core-runtime-infra-cli-ui",
      "core-runtime-infra-device",
      "core-runtime-infra-diagnostics-state",
      "core-runtime-infra-core-utils",
      "core-runtime-infra-env-auth",
      "core-runtime-infra-events-runtime",
      "core-runtime-infra-file-safety",
      "core-runtime-infra-files-commands",
      "core-runtime-infra-gateway-lock-argv",
      "core-runtime-infra-gateway-processes",
      "core-runtime-infra-gateway-watch",
      "core-runtime-infra-heartbeat-core",
      "core-runtime-infra-heartbeat-runner",
      "core-runtime-infra-misc",
      "core-runtime-infra-misc-dedupe-disk",
      "core-runtime-infra-misc-os",
      "core-runtime-infra-misc-values",
      "core-runtime-infra-net-install",
      "core-runtime-infra-network-node",
      "core-runtime-infra-network-platform",
      "core-runtime-infra-outbound-actions",
      "core-runtime-infra-outbound-core",
      "core-runtime-infra-provider-push",
      "core-runtime-infra-repo-tooling",
      "core-runtime-infra-storage-state",
      "core-runtime-infra-system-runtime",
      "core-runtime-infra-process",
    ]);
    expect(actual).toEqual(
      [...new Set([...listTestFiles("src/infra"), ...databaseWorkerCoreTestFiles])].toSorted(
        (a, b) => a.localeCompare(b),
      ),
    );
    expect(new Set(actual).size).toBe(actual.length);
  });

  it.each(["github", "blacksmith", "hybrid"] as const)(
    "bounds storage-state files per physical %s job without losing coverage",
    (runnerBackend) => {
      const owner = "core-runtime-infra-storage-state";
      const expected = defaultShards.find((shard) => shard.shardName === owner)!.includePatterns!;
      const plan = getCommittedCompactPlan("pull-request", runnerBackend);
      const actual: string[] = [];
      for (const job of plan) {
        const files = job.groups
          .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner)
          .flatMap((group) => group.includePatterns ?? []);
        expect(files.length, job.shardName).toBeLessThanOrEqual(64);
        actual.push(...files);
      }
      expect(actual.toSorted()).toEqual(expected.toSorted());
      expect(new Set(actual).size).toBe(actual.length);
      expect(plan.length).toBeLessThanOrEqual(90);
      const config = createInfraVitestConfig({});
      expect(config.test?.fileParallelism).toBe(sharedVitestConfig.test.fileParallelism);
      expect(config.test?.maxWorkers).toBe(sharedVitestConfig.test.maxWorkers);
      expect(config.test?.isolate).toBe(true);
      expect(config.test?.pool).toBe(diagnosticForksPool);
    },
  );

  it("runs only native Gateway lifecycle fixtures before parallel files without widening selectors", () => {
    const config = createGatewayServerVitestConfig({ OPENCLAW_VITEST_MAX_WORKERS: "8" }, true);
    const native = gatewayServerSerialTestFiles.map((file) => relative("src/gateway", file));
    const sequence = config.test?.sequence?.groupOrder ?? 0;
    expect(config.test?.projects).toMatchObject([
      {
        extends: false,
        test: {
          name: "gateway-server-native",
          pool: "forks",
          isolate: false,
          fileParallelism: false,
          maxWorkers: 1,
          include: native,
          runner: config.test?.runner,
          setupFiles: config.test?.setupFiles,
          sequence: { groupOrder: sequence },
        },
      },
      {
        extends: false,
        test: {
          name: "gateway-server-parallel",
          pool: "forks",
          isolate: false,
          fileParallelism: true,
          maxWorkers: undefined,
          include: config.test?.include,
          exclude: expect.arrayContaining(native),
          runner: config.test?.runner,
          setupFiles: config.test?.setupFiles,
          sequence: { groupOrder: sequence + 1 },
        },
      },
    ]);
    expect(listMatchedTestFiles(config)).toEqual(
      defaultShards
        .filter((shard) => shard.configs.includes("test/vitest/vitest.gateway-server.config.ts"))
        .flatMap((shard) => shard.includePatterns!)
        .toSorted(),
    );
    const selected = [
      gatewayServerSerialTestFiles[0]!,
      "src/gateway/server.models-voicewake-misc.test.ts",
    ];
    const includeFile = join(tempDirs.make("gateway-native-selection-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(selected));
    const narrowed = createGatewayServerVitestConfig(
      {
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        OPENCLAW_VITEST_MAX_WORKERS: "8",
      },
      true,
    );
    expect(listMatchedTestFiles(narrowed)).toEqual(selected.toSorted());
    expect(narrowed.test?.projects).toMatchObject([
      { test: { include: [native[0]] } },
      {
        test: {
          include: selected.map((file) => relative("src/gateway", file)),
          exclude: expect.arrayContaining(native),
        },
      },
    ]);
  });

  it("preserves Gateway runner hooks while assigning database consumers to parallel forks", () => {
    const worker = createGatewayDatabaseWorkersVitestConfig({});
    const core = createGatewayCoreVitestConfig({});
    const server = createGatewayServerVitestConfig({ OPENCLAW_VITEST_MAX_WORKERS: "8" });
    const methods = createGatewayMethodsVitestConfig({});
    expect(server.test?.fileParallelism).toBe(true);
    expect(
      createGatewayServerVitestConfig({ OPENCLAW_VITEST_MAX_WORKERS: "1" }).test?.fileParallelism,
    ).toBe(false);
    expect(methods.test?.pool).toBe("forks");
    expect(worker.test?.pool).toBe("forks");
    expect(worker.test?.fileParallelism).toBe(true);
    expect(core.test?.isolate).toBe(true);
    for (const shared of [worker, server, methods]) {
      expect(shared.test?.isolate).toBe(false);
    }
    for (const previous of [core, server, methods]) {
      expect(worker.test?.runner).toBe(previous.test?.runner);
      expect(worker.test?.setupFiles).toEqual(previous.test?.setupFiles);
    }
    expect(listMatchedTestFiles(worker)).toEqual(gatewayDatabaseWorkerTestFiles);
    expect(listMatchedTestFiles(worker)).toEqual(
      expect.arrayContaining([
        "src/gateway/session-utils.queued-collector-admission.test.ts",
        "src/gateway/session-utils.queued-collector.test.ts",
      ]),
    );
    const former = new Set([core, server, methods].flatMap(listMatchedTestFiles));
    for (const file of gatewayDatabaseWorkerTestFiles) {
      expect(former.has(file), file).toBe(false);
      expect(isGatewayServerTestFile(file), file).toBe(false);
    }
    expect(
      defaultShards.filter((shard) =>
        shard.configs.includes("test/vitest/vitest.gateway-database-workers.config.ts"),
      ),
    ).toHaveLength(1);
    const includeFile = join(tempDirs.make("gateway-database-routing-"), "include.json");
    writeFileSync(includeFile, JSON.stringify([gatewayDatabaseWorkerTestFiles[0]]));
    expect(
      listMatchedTestFiles(
        createGatewayDatabaseWorkersVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
      ),
    ).toEqual([gatewayDatabaseWorkerTestFiles[0]]);
  });

  it("keeps host-owned database consumers in forks and out of their former projects", () => {
    const infra = createInfraVitestConfig({});
    const support = createAgentsSupportVitestConfig({});
    expect(infra.test?.pool).toBe(diagnosticForksPool);
    expect(infra.test?.isolate).toBe(true);
    expect(infra.test?.setupFiles).toEqual(support.test?.setupFiles);
    const admitted = new Set(listMatchedTestFiles(infra));
    for (const file of [
      "src/agents/sessions/sdk.auth-migration.test.ts",
      "src/agents/subagents/spawn/subagent-spawn.in-process-gateway.test.ts",
      "src/agents/subagents/spawn/subagent-spawn.authority.test.ts",
      "src/agents/tools/swarm-tools.integration.test.ts",
      "src/config/sessions/disk-budget.physical-usage.test.ts",
    ]) {
      expect(admitted.has(file), file).toBe(true);
    }
    const former = new Set(
      [
        createUnitVitestConfigWithOptions({}),
        createUnitFastVitestConfig(),
        createAgentsCoreVitestConfig({}),
        createAgentsCoreIsolatedVitestConfig({}),
        support,
        createAgentsToolsVitestConfig({}),
        createAgentsVitestConfig({}),
        createPluginSdkLightVitestConfig({}),
        createPluginSdkVitestConfig({}),
        createPluginsVitestConfig({}),
        createTasksVitestConfig({}),
        createToolingVitestConfig({}),
        createWizardVitestConfig({}),
        createCommandsVitestConfig({}),
        createRuntimeConfigVitestConfig({}),
      ].flatMap(listMatchedTestFiles),
    );
    for (const file of databaseWorkerCoreTestFiles) {
      expect(admitted.has(file), file).toBe(true);
      expect(former.has(file), file).toBe(false);
    }
    const recoveryTest = "src/wizard/setup.inference-recovery.integration.test.ts";
    expect(admitted.has(recoveryTest), recoveryTest).toBe(true);
    expect(former.has(recoveryTest), recoveryTest).toBe(false);
    const selected = [
      "src/plugin-state/plugin-state-store.test.ts",
      "test/plugins/beam-http-identity.test.ts",
    ];
    const includeFile = join(tempDirs.make("database-worker-routing-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(selected));
    expect(
      listMatchedTestFiles(
        createInfraVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile }),
      ).toSorted(),
    ).toEqual(selected.toSorted());
  });

  it("covers every cron test exactly once across core runtime cron shards", () => {
    const cronShards = defaultShards.filter((shard) =>
      shard.shardName.startsWith("core-runtime-cron-"),
    );
    const actual = cronShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(cronShards.map((shard) => shard.shardName)).toEqual([
      "core-runtime-cron-parallel-core",
      "core-runtime-cron-parallel-isolated-agent",
      "core-runtime-cron-parallel-service",
    ]);
    expect(actual).toEqual(listTestFiles("src/cron"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "prices parallel cron from serial work until %s has direct measurements",
    (runnerBackend) => {
      const original = fullSuiteVitestShards.slice();
      try {
        const cron = "test/vitest/vitest.cron.config.ts";
        fullSuiteVitestShards.splice(
          0,
          fullSuiteVitestShards.length,
          ...original
            .filter((shard) => shard.projects.includes(cron))
            .map((shard) => Object.assign({}, shard, { projects: [cron] })),
        );
        const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({
          "core-runtime-cron-core": 40,
          "core-runtime-cron-isolated-agent": 100,
          "core-runtime-cron-service": 140,
        });
        const options = { compactMode: "pull-request" as const, runnerBackend };
        const baseline = createNodeTestShardBundles(options);
        const totalSeconds = (plan: typeof baseline) =>
          plan.reduce((total, job) => total + job.predictedSeconds!, 0);
        expect(totalSeconds(baseline)).toBe(runnerBackend === "hybrid" ? 122 : 140);
        expect(baseline.flatMap((job) => job.groups)).toHaveLength(3);
        timings.mockReturnValue({
          "core-runtime-cron-core": 400,
          "core-runtime-cron-isolated-agent": 1_000,
          "core-runtime-cron-service": 1_400,
          "core-runtime-cron-parallel-core": 20,
          "core-runtime-cron-parallel-isolated-agent": 60,
          "core-runtime-cron-parallel-service": 80,
        });
        const measured = createNodeTestShardBundles(options);
        expect(totalSeconds(measured)).toBe(runnerBackend === "hybrid" ? 139 : 160);
        const groups = measured.flatMap((job) => job.groups);
        expect(groups).toHaveLength(3);
        expect(groups.every((group) => group.env === undefined)).toBe(true);
        expect(groups.every((group) => group.fallbackMaxWorkers === undefined)).toBe(true);
        expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
          baseline
            .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
            .toSorted(),
        );
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
      }
    },
  );

  it("splits the agentic lane into control-plane, command, agent, gateway, SDK, and plugin shards", () => {
    const shards = defaultShards;
    const controlPlaneShards = shards.filter((shard) =>
      shard.shardName.startsWith("agentic-control-plane-"),
    );
    const cliShard = shards.find((shard) => shard.shardName === "agentic-cli");
    const cliProcessShard = shards.find((shard) => shard.shardName === "agentic-cli-process");
    const commandSupportShard = shards.find(
      (shard) => shard.shardName === "agentic-command-support",
    );
    const commandShards = shards.filter((shard) => shard.shardName.startsWith("agentic-commands-"));
    const agentShards = shards.filter((shard) => shard.shardName.startsWith("agentic-agents-"));
    const gatewayCoreShards = shards.filter((shard) =>
      shard.shardName.startsWith("agentic-gateway-core-"),
    );
    const gatewayMethodsShard = shards.find(
      (shard) => shard.shardName === "agentic-gateway-methods",
    );
    const pluginSdkShard = shards.find((shard) => shard.shardName === "agentic-plugin-sdk");
    const pluginsShard = shards.find((shard) => shard.shardName === "agentic-plugins");

    expect(controlPlaneShards.map((shard) => shard.shardName)).toEqual([
      "agentic-control-plane-agent-chat",
      "agentic-control-plane-auth-node",
      "agentic-control-plane-http-models",
      "agentic-control-plane-http-plugin-ws",
      "agentic-control-plane-runtime",
      "agentic-control-plane-runtime-config",
      "agentic-control-plane-runtime-cron",
      "agentic-control-plane-runtime-server",
      "agentic-control-plane-runtime-shared-token",
      "agentic-control-plane-runtime-state",
      "agentic-control-plane-runtime-ui-tools",
      "agentic-control-plane-startup-config",
      "agentic-control-plane-startup-core",
      "agentic-control-plane-startup-health-runtime",
      "agentic-control-plane-startup-restart-close",
    ]);
    expect(controlPlaneShards).toEqual(
      controlPlaneShards.map((shard) => ({
        checkName: `checks-node-${shard.shardName}`,
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
        ...(shard.shardName === "agentic-control-plane-runtime-config"
          ? { pretestBuildMode: "runtime" }
          : {}),
        ...(shard.shardName === "agentic-control-plane-startup-health-runtime"
          ? { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" } }
          : {}),
        ...(shard.includePatterns?.includes("src/gateway/server-sidecar-retention.test.ts")
          ? { pretestBuildMode: "runtime" }
          : {}),
        includePatterns: shard.includePatterns,
        requiresDist: false,
        runner:
          shard.shardName === "agentic-control-plane-startup-core"
            ? DEFAULT_NODE_TEST_RUNNER
            : "blacksmith-4vcpu-ubuntu-2404",
        shardName: shard.shardName,
      })),
    );
    const controlPlaneShardFiles = controlPlaneShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedControlPlaneFiles = listMatchedTestFiles(
      createGatewayServerVitestConfig({
        ...process.env,
        OPENCLAW_VITEST_INCLUDE_FILE: undefined,
      }),
    );
    expect(
      listTestFiles("src/gateway")
        .filter(isGatewayServerTestFile)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(expectedControlPlaneFiles);
    expect(controlPlaneShardFiles).toEqual(expectedControlPlaneFiles);
    expect(new Set(controlPlaneShardFiles).size).toBe(controlPlaneShardFiles.length);
    expect(cliShard).toEqual({
      checkName: "checks-node-agentic-cli",
      shardName: "agentic-cli",
      configs: ["test/vitest/vitest.cli.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(cliProcessShard).toEqual({
      checkName: "checks-node-agentic-cli-process",
      shardName: "agentic-cli-process",
      configs: ["test/vitest/vitest.cli-process.config.ts"],
      pretestBuildMode: "runtime",
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(commandSupportShard).toEqual({
      checkName: "checks-node-agentic-command-support",
      shardName: "agentic-command-support",
      configs: [
        "test/vitest/vitest.commands-light.config.ts",
        "test/vitest/vitest.daemon.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(commandShards.map((shard) => shard.shardName)).toEqual([
      "agentic-commands-agent-channel",
      "agentic-commands-doctor",
      "agentic-commands-doctor-auth",
      "agentic-commands-doctor-config-state",
      "agentic-commands-doctor-gateway",
      "agentic-commands-doctor-platform",
      "agentic-commands-doctor-plugins-tools",
      "agentic-commands-doctor-sessions-cron",
      "agentic-commands-doctor-sessions-cron-memory",
      "agentic-commands-doctor-sessions-cron-sqlite",
      "agentic-commands-doctor-sessions-cron-sqlite-recovery",
      "agentic-commands-doctor-shared",
      "agentic-commands-doctor-whatsapp",
      "agentic-commands-doctor-workspace",
      "agentic-commands-models",
      "agentic-commands-onboard-config",
      "agentic-commands-status-tools",
      "agentic-commands-runtime",
    ]);
    expect(commandShards).toEqual(
      commandShards.map((shard) => ({
        checkName: `checks-node-${shard.shardName}`,
        configs: ["test/vitest/vitest.commands.config.ts"],
        includePatterns: shard.includePatterns,
        ...(shard.shardName === "agentic-commands-runtime" ? { pretestBuildMode: "runtime" } : {}),
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: shard.shardName,
      })),
    );
    expect(
      commandShards.find((shard) => shard.shardName === "agentic-commands-doctor-auth")
        ?.includePatterns,
    ).toContain("src/commands/oauth-tls-preflight.doctor.test.ts");
    const commandShardFiles = commandShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedCommandFiles = listMatchedTestFiles(createCommandsVitestConfig({}));
    expect(commandShardFiles).toEqual(expectedCommandFiles);
    expect(new Set(commandShardFiles).size).toBe(commandShardFiles.length);
    expect(agentShards).toEqual([
      {
        checkName: "checks-node-agentic-agents-core-auth",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[0]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-auth",
      },
      {
        checkName: "checks-node-agentic-agents-core-models",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[1]?.includePatterns,
        pretestBuildMode: "runtime",
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-models",
      },
      {
        checkName: "checks-node-agentic-agents-core-tools",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[2]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-tools",
      },
      {
        checkName: "checks-node-agentic-agents-core-subagents",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[3]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-subagents",
      },
      // Retain the import-heavy CLI stripes alongside bounded file workers.
      {
        checkName: "checks-node-agentic-agents-core-runner-cli-1",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[4]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-cli-1",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-cli-2",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[5]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-cli-2",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-cli-3",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[6]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-cli-3",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-commands",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[7]?.includePatterns,
        requiresDist: false,
        pretestBuildMode: "runtime",
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-commands",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-embedded",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[8]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-embedded",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-sessions",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[9]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-sessions",
      },
      {
        checkName: "checks-node-agentic-agents-core-runtime",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[10]?.includePatterns,
        pretestBuildMode: "runtime",
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runtime",
      },
      {
        checkName: "checks-node-agentic-agents-core-spawn-production-boundary",
        configs: ["test/vitest/vitest.agents-spawn-production-boundary.config.ts"],
        includePatterns: agentShards[11]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-spawn-production-boundary",
      },
      {
        checkName: "checks-node-agentic-agents-core-isolated",
        configs: ["test/vitest/vitest.agents-core-isolated.config.ts"],
        includePatterns: agentShards[12]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-isolated",
      },
      {
        checkName: "checks-node-agentic-agents-embedded",
        configs: [
          "test/vitest/vitest.agents-embedded-agent.config.ts",
          "test/vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts",
          "test/vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts",
          "test/vitest/vitest.agents-embedded-agent-run.config.ts",
        ],
        env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "660000" },
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-embedded",
      },
      {
        checkName: "checks-node-agentic-agents-support",
        configs: ["test/vitest/vitest.agents-support.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-support",
      },
      {
        checkName: "checks-node-agentic-agents-tools",
        configs: ["test/vitest/vitest.agents-tools.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-tools",
      },
    ]);
    expect(pluginSdkShard).toEqual({
      checkName: "checks-node-agentic-plugin-sdk",
      shardName: "agentic-plugin-sdk",
      configs: [
        "test/vitest/vitest.plugin-sdk-light.config.ts",
        "test/vitest/vitest.plugin-sdk.config.ts",
      ],
      pretestBuildMode: "runtime",
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    const gatewayCoreConfigs = [
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
    ];
    expect(gatewayCoreShards.slice(0, 3)).toEqual(
      [1, 2, 3].map((stripe) => ({
        checkName: `checks-node-agentic-gateway-core-${stripe}`,
        shardName: `agentic-gateway-core-${stripe}`,
        configs: gatewayCoreConfigs,
        includePatterns: gatewayCoreShards[stripe - 1]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
      })),
    );
    // The pretest runtime build is charged per job, so the files that need it
    // stay in one shard; the ordinary stripes must never carry a build mode.
    expect(gatewayCoreShards.filter((shard) => shard.pretestBuildMode != null)).toEqual([
      {
        checkName: "checks-node-agentic-gateway-core-runtime",
        shardName: "agentic-gateway-core-runtime",
        configs: gatewayCoreConfigs,
        includePatterns: [
          "src/gateway/gateway-active-memory.test.ts",
          "src/gateway/gateway-concurrent-streams.test.ts",
        ],
        pretestBuildMode: "runtime",
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
      },
    ]);
    expect(gatewayMethodsShard).toEqual({
      checkName: "checks-node-agentic-gateway-methods",
      shardName: "agentic-gateway-methods",
      configs: [
        "test/vitest/vitest.gateway-methods.config.ts",
        "test/vitest/vitest.gateway-methods-isolated.config.ts",
      ],
      pretestBuildMode: "runtime",
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      shardName: "agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      pretestBuildMode: "runtime",
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
  });

  it("keeps plugin prerelease npm install behavior on the release-only agentic plugin shard", () => {
    const pluginsShard = defaultShards.find((shard) => shard.shardName === "agentic-plugins");

    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      pretestBuildMode: "runtime",
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: "agentic-plugins",
    });
    expect(listMatchedTestFiles(createPluginsVitestConfig({}))).toContain(
      PLUGIN_PRERELEASE_NPM_SPEC_TEST,
    );
  });

  it("covers flat agents-core and explicitly nested isolated tests exactly once", () => {
    const actual = defaultShards
      .filter((shard) => shard.shardName.startsWith("agentic-agents-core-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expected = [
      ...listTestFiles("src/agents").filter(
        (file) => !relative("src/agents", file).replaceAll("\\", "/").includes("/"),
      ),
      ...agentVitestProjectOwners.coreIsolated.include.filter((file) =>
        relative("src/agents", file).replaceAll("\\", "/").includes("/"),
      ),
      ...agentVitestProjectOwners.spawnProductionBoundary.include,
    ]
      .filter((file) => !databaseWorkerCoreTestFiles.includes(file))
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps embedded-agent tests in four bounded config surfaces", () => {
    const shard = defaultShards.find(
      (candidate) => candidate.shardName === "agentic-agents-embedded",
    );
    const incompleteTurnFiles = new Set(agentVitestProjectOwners.embeddedIncompleteTurn.include);
    const overflowCompactionFiles = new Set(
      agentVitestProjectOwners.embeddedOverflowCompaction.include,
    );
    const actual = [
      ...globSync(agentVitestProjectOwners.embedded.include)
        .map(toRepoPath)
        .filter((file) => !incompleteTurnFiles.has(file) && !overflowCompactionFiles.has(file)),
      ...agentVitestProjectOwners.embeddedIncompleteTurn.include,
      ...agentVitestProjectOwners.embeddedOverflowCompaction.include,
      ...globSync(agentVitestProjectOwners.embeddedRun.include).map(toRepoPath),
    ].toSorted((left, right) => left.localeCompare(right));
    const expected = listTestFiles("src/agents/embedded-agent-runner").toSorted((left, right) =>
      left.localeCompare(right),
    );

    expect(shard?.configs).toEqual(embeddedAgentVitestProjectOwners.map((owner) => owner.config));
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps expensive plugin shards release-only when normal CI asks for the cheaper plan", () => {
    const shards = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const shardNames = shards.map((shard) => shard.shardName);

    expect(shardNames).not.toContain("agentic-plugins");
    expect(shardNames).toContain("agentic-gateway-core-1");
    expect(shardNames).toContain("agentic-gateway-core-2");
    expect(shardNames).toContain("agentic-gateway-core-3");
    expect(shardNames).toContain("agentic-gateway-methods");
    expect(shardNames).toContain("agentic-plugin-sdk");
  });

  it.each(
    (["blacksmith", "github", "hybrid"] as const).flatMap((runnerBackend) =>
      [{ file: "test/plugins/codex-model-catalog.gateway.test.ts", buildMode: "runtime" }].map(
        ({ file, buildMode }) => ({ file, buildMode, runnerBackend }),
      ),
    ),
  )(
    "keeps changed Gateway build selection for $file on $runnerBackend",
    ({ file, buildMode, runnerBackend }) => {
      const shards = createChangedNodeTestShards([file], { runnerBackend });
      const owners = (shards ?? []).flatMap((shard) =>
        (shard.groups ?? []).flatMap((group) =>
          (group.includePatterns ?? [])
            .filter((selected) => selected === file)
            .map(() => ({ shard, group })),
        ),
      );
      expect(owners).toHaveLength(1);
      const owner = expectDefined(owners[0], "selected Gateway execution");
      expect(owner.group.includePatterns).toEqual([file]);
      expect(owner.group.configs.toSorted()).toEqual([
        "test/vitest/vitest.gateway-database-workers.config.ts",
        "test/vitest/vitest.gateway-server-isolated.config.ts",
      ]);
      expect(owner.group.pretestBuildMode).toBe(buildMode);
      expect(owner.shard.planConcurrency).toBe(1);
      if (buildMode) {
        expect(owner.shard.pretestBuildMode).toBe(buildMode);
      }
    },
  );

  it("keeps the complete tooling family in manual plans and omits it from product plans", () => {
    const automatic = createNodeTestShards({
      includeReleaseOnlyToolingShards: false,
      changedPaths: ["src/plugin-sdk/core.ts", "src/infra/home-dir.test.ts"],
    });
    expect(defaultShards.some((shard) => shard.shardName.startsWith("core-tooling-"))).toBe(true);
    expect(automatic.some((shard) => shard.shardName.startsWith("core-tooling-"))).toBe(false);
    expect(automatic.flatMap((shard) => shard.includePatterns ?? [])).not.toEqual(
      expect.arrayContaining([RELEASE_REPORT_OWNER_TEST, "test/scripts/arg-utils.test.ts"]),
    );
    for (const shard of automatic) {
      expect(shard.includePatterns?.some((file) => file.startsWith("test/scripts/"))).not.toBe(
        true,
      );
    }
    expect(automatic.flatMap((shard) => shard.includePatterns ?? [])).toContain(
      "src/infra/home-dir.test.ts",
    );
  });

  it.each([
    RELEASE_REPORT_OWNER_TEST,
    "test/scripts/arg-utils.test.ts",
    "scripts/lib/vitest-report-owner.mts",
    "scripts/test-extension-batch.mts",
    "src/scripts/example.ts",
    "scripts/README.md",
    "config/ci-budget.md",
    "test/vitest/vitest.tooling.config.ts",
    "test/helpers/temp-dir.ts",
    "config/ci-test-timings.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches/vitest@5.0.0.patch",
    ".github/workflows/ci.yml",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".crabbox.yaml",
    "Dockerfile",
    "apps/ios/fastlane/Fastfile",
    "extensions/matrix/package.json",
    "extensions/matrix/scripts/build.mjs",
  ])("retains the complete tooling family when owner %s changes", (changedPath) => {
    expect(
      createNodeTestShards({
        includeReleaseOnlyToolingShards: false,
        changedPaths: ["src/plugin-sdk/core.ts", changedPath],
      }),
    ).toEqual(defaultShards);
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "preserves product coverage and canonical tooling owners across the %s release tier",
    (runnerBackend) => {
      const options = {
        compactMode: "pull-request" as const,
        includeReleaseOnlyPluginShards: false,
        runnerBackend,
      };
      const full = getCommittedCompactPlan("pull-request", runnerBackend);
      const automatic = createNodeTestShardBundles({
        ...options,
        includeReleaseOnlyToolingShards: false,
        changedPaths: ["src/gateway/server.ts"],
      });
      const fullGroups = full.flatMap((job) => job.groups);
      const automaticGroups = automatic.flatMap((job) => job.groups);
      const productFiles = (groups: typeof fullGroups) =>
        groups
          .filter((group) => !group.configs.some((config) => config.includes("vitest.tooling")))
          .flatMap(
            (group) =>
              group.includePatterns ??
              group.configs.flatMap((config) => {
                if (config === "test/vitest/vitest.unit-fast-isolated.config.ts") {
                  return getUnitFastIsolatedTestFiles();
                }
                if (config === "test/vitest/vitest.unit-fast-fake-timers.config.ts") {
                  return getUnitFastTimerTestFiles();
                }
                return [];
              }),
          )
          .filter((file) => !file.startsWith("test/scripts/") && !file.startsWith("src/scripts/"))
          .toSorted();
      expect(
        automaticGroups.some((group) =>
          group.configs.some((config) => config.includes("vitest.tooling")),
        ),
      ).toBe(false);
      expect(
        automaticGroups
          .flatMap((group) => group.includePatterns ?? [])
          .some((file) => file.startsWith("test/scripts/")),
      ).toBe(false);
      expect(productFiles(automaticGroups)).toEqual(productFiles(fullGroups));
      expect(
        createNodeTestShardBundles({
          ...options,
          includeReleaseOnlyToolingShards: false,
          changedPaths: ["package.json"],
        }),
      ).toEqual(full);
      const push = createNodeTestShardBundles({
        ...options,
        compactMode: "push",
        includeReleaseOnlyToolingShards: false,
        changedPaths: ["package.json"],
      });
      expect(
        push
          .flatMap((job) => job.groups)
          .some((group) => group.configs.some((config) => config.includes("vitest.tooling"))),
      ).toBe(false);
      expect(
        push
          .flatMap((job) => job.groups)
          .flatMap((group) => group.includePatterns ?? [])
          .some((file) => file.startsWith("test/scripts/")),
      ).toBe(false);
    },
  );

  it("keeps changed native browser tests in UI jobs and out of extension fallback", () => {
    const target = "extensions/workboard/browser/catalog.test.ts";
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.targets ?? shard.includePatterns ?? [])).toContain(
      target,
    );
    expect(createChangedExtensionFallbackShards([target])).toEqual([]);
  });

  it("prepares the sticker provider runtime in extension fallback", () => {
    const target = "extensions/telegram/src/sticker-cache.selection.test.ts";
    const owners = createChangedExtensionFallbackShards([target]).filter((shard) =>
      (shard.groups ?? [shard]).some((group) => group.includePatterns?.includes(target)),
    );

    expect(owners).toHaveLength(1);
    expect(owners[0]?.pretestBuildMode).toBe("runtime");
  });

  it("retains the changed host plugin test when the store-alias diff forces fallback", () => {
    expect(createChangedNodeTestShards(STORE_ALIAS_CHANGED_PATHS)).toBeNull();
    const options = {
      changedPaths: STORE_ALIAS_CHANGED_PATHS,
      includeReleaseOnlyPluginShards: false,
    };
    const shards = [
      ...createNodeTestShards(options),
      ...createChangedExtensionFallbackShards(STORE_ALIAS_CHANGED_PATHS),
    ];
    expect(shards.filter((shard) => shard.shardName === "agentic-plugins")).toEqual([
      {
        checkName: "checks-node-agentic-plugins",
        shardName: "agentic-plugins",
        configs: ["test/vitest/vitest.plugins.config.ts"],
        includePatterns: ["src/plugins/tools.optional.test.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
      },
    ]);
  });

  it("retains only exact changed plugin-owner tests in deterministic order", () => {
    const options = {
      includeReleaseOnlyPluginShards: false,
      changedPaths: [
        ...STORE_ALIAS_CHANGED_PATHS.toReversed(),
        " src/plugins/tools.optional.test.ts",
        String.raw`src\plugins\tools.optional.test.ts`,
        "src/plugins/tools.optional.test.ts",
        PLUGIN_PRERELEASE_NPM_SPEC_TEST,
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        "src/plugins/loader.test.ts",
        "src/plugins/install.npm-spec.e2e.test.ts",
      ],
    };
    const shards = createNodeTestShards(options);
    expect(shards.find((shard) => shard.shardName === "agentic-plugins")?.includePatterns).toEqual([
      PLUGIN_PRERELEASE_NPM_SPEC_TEST,
      "src/plugins/tools.optional.test.ts",
    ]);
    expect(shards.filter((shard) => shard.shardName !== "agentic-plugins")).toEqual(
      createNodeTestShards({ includeReleaseOnlyPluginShards: false }),
    );
    expect(createNodeTestShards({ ...options, includeReleaseOnlyPluginShards: true })).toEqual(
      defaultShards,
    );
  });

  it("does not widen plugin coverage for deleted tests, sources, docs, or directories", () => {
    const deletedTest = "src/plugins/deleted-ci-routing.test.ts";
    expect(existsSync(deletedTest)).toBe(false);
    const options = {
      includeReleaseOnlyPluginShards: false,
      changedPaths: [deletedTest, "src/plugins/tools.ts", "src/plugins", "docs/ci.md"],
    };
    expect(createNodeTestShards(options)).toEqual(
      createNodeTestShards({ includeReleaseOnlyPluginShards: false }),
    );
  });

  it.each(
    plannerHosts.flatMap((host) =>
      ["blacksmith", "github", "hybrid"].map((runnerBackend) =>
        Object.assign({}, host, { runnerBackend }),
      ),
    ),
  )(
    "retains changed plugin tests once in $runnerBackend compact fallback without changing group policies ($label)",
    ({ runnerBackend, ...host }) => {
      pinPlannerHost(host);
      const options = {
        compactMode: "pull-request" as const,
        includeReleaseOnlyPluginShards: false,
        runnerBackend,
      };
      const changedOptions = { ...options, changedPaths: STORE_ALIAS_CHANGED_PATHS };
      // Each input has its own admission before runtime placement materializes caps.
      const observations = vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      const beforeAdmission = createNodeTestShardBundles(options);
      const afterAdmission = createNodeTestShardBundles(changedOptions);
      observations.mockRestore();
      const before = getCommittedCompactPlan(options.compactMode, runnerBackend);
      const after = createNodeTestShardBundles(changedOptions);
      const groups = after.flatMap((shard) => shard.groups);
      type Group = (typeof groups)[number];
      const isRepartitionableTooling = (group: Group) =>
        runnerBackend === "github" &&
        /^core-tooling-\d+-hosted-\d+$/u.test(group.shard_name) &&
        group.configs.includes("test/vitest/vitest.tooling.config.ts") &&
        group.includePatterns !== undefined &&
        group.includePatterns.length > 0 &&
        !group.requiresDist &&
        group.pretestBuildMode === undefined &&
        [BUNDLED_NODE_TEST_RUNNER, DEFAULT_NODE_TEST_RUNNER, EXTRA_LARGE_NODE_TEST_RUNNER].includes(
          group.runner,
        );
      const toolingParent = (group: Group) => group.shard_name.replace(/-hosted-\d+$/u, "");
      const parallelTimingSuffix = (files: readonly string[] | undefined) =>
        files?.some((file) => gatewayServerSerialTestFiles.includes(file))
          ? "-parallel-native-serial"
          : "-parallel";
      const timingFamilies = (plan: typeof before) => {
        const families = new Map<string, Array<{ group: Group; part: number }>>();
        for (const group of plan.flatMap((shard) => shard.groups)) {
          const parallelAutoReply =
            group.configs.length === 1 &&
            group.configs[0] === "test/vitest/vitest.auto-reply-reply.config.ts";
          if (parallelAutoReply || /^core-tooling-\d+-hosted-\d+$/u.test(group.shard_name)) {
            expect(group.timing_key).toBeDefined();
          }
          if (
            group.timing_key === undefined ||
            (fileParallelAgentGroupNames.has(group.shard_name) &&
              group.timing_key === `${group.shard_name}#file-parallel`)
          ) {
            continue;
          }
          if (parallelAutoReply) {
            expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
          }
          const parallelCommands = group.configs.includes("test/vitest/vitest.commands.config.ts");
          if (parallelCommands && /#file-parallel-(?:2|8)$/u.test(group.timing_key)) {
            expect(group.timing_key).toMatch(
              new RegExp(`^${group.shard_name}#file-parallel-(2|8)$`),
            );
            continue;
          }
          const isParallelServer =
            group.configs.length === 1 &&
            group.configs[0] === "test/vitest/vitest.gateway-server.config.ts";
          const parallelAgentsCore =
            group.configs.length === 1 && group.configs[0] === agentVitestProjectOwners.core.config;
          if (parallelAgentsCore && !group.shard_name.includes("-hosted-")) {
            expect(group.timing_key).toBe(`${group.shard_name}-parallel`);
            expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
            continue;
          }
          const key = parseCompactSplitTimingKey(group.timing_key);
          if (!key) {
            expect(parallelAutoReply || isParallelServer).toBe(true);
            expect(group.timing_key).toBe(
              `${group.shard_name}${parallelAutoReply ? "-parallel-2" : parallelTimingSuffix(group.includePatterns)}`,
            );
            continue;
          }
          const parent = key.parentShardName;
          const part = key.part;
          const hostedName = /^(.+)-hosted-([1-9]\d*)$/u.exec(group.shard_name);
          const parentName = hostedName?.[1] ?? group.shard_name;
          const parentFiles = defaultShards.find(
            (shard) => shard.shardName === parentName,
          )?.includePatterns;
          expect(parent, "timing key parent must match hosted group name").toBe(
            `${parentName}${parallelAutoReply ? "-parallel-2" : isParallelServer ? `${parallelTimingSuffix(parentFiles)}-stripes` : parallelAgentsCore ? "-parallel" : ""}${parallelCommands ? group.timing_key.match(/#file-parallel-(?:2|8)/u)?.[0] : ""}`,
          );
          expect(part, "timing key part must match hosted group ordinal").toBe(
            hostedName ? Number(hostedName[2]) : 1,
          );
          const familyParent = parent.replace("#file-parallel-8", "#file-parallel-2");
          const family = families.get(familyParent) ?? [];
          family.push({ group, part });
          families.set(familyParent, family);
        }
        for (const family of families.values()) {
          family.sort((a, b) => a.part - b.part);
        }
        return families;
      };
      // Hosted declarations keep their original pins and never transfer a measured
      // Gateway bin's job cap into sibling env. They remain an independent oracle.
      const hostedDeclarations = new Map<string, Group["env"]>();
      for (const group of getCommittedCompactPlan(options.compactMode, "github").flatMap(
        (job) => job.groups,
      )) {
        const owner = group.shard_name.replace(/-hosted-\d+$/u, "");
        if (hostedDeclarations.has(owner)) {
          expect(group.env).toEqual(hostedDeclarations.get(owner));
        }
        hostedDeclarations.set(owner, group.env);
      }
      // The changed-only plugin fixture is absent from the normal compact plan.
      for (const shard of defaultShards) {
        if (!hostedDeclarations.has(shard.shardName)) {
          hostedDeclarations.set(shard.shardName, shard.env);
        }
      }
      const inheritedGroupsFor = (admission: typeof before) => {
        const inherited = new Map(
          admission.flatMap((job) =>
            job.planConcurrency === 2
              ? job.groups
                  .filter(
                    (group) =>
                      group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined &&
                      group.fallbackMaxWorkers === undefined,
                  )
                  .map((group): [string, Group] => [group.shard_name, group])
              : [],
          ),
        );
        for (const job of admission) {
          // Runtime and dist rows were already serial; only ordinary 32-class
          // Gateway rows transfer an admitted job cap onto unmeasured siblings.
          if (
            runnerBackend === "github" ||
            !usesParallelPacking(job) ||
            job.runner !== EXTRA_LARGE_NODE_TEST_RUNNER ||
            job.pretestBuildMode !== undefined ||
            job.requiresDist ||
            !job.groups.some((group) => group.fallbackMaxWorkers === 2) ||
            !job.groups.some((group) => group.configs.some(isExclusiveCiTestConfig))
          ) {
            continue;
          }
          expect(job.planConcurrency).toBe(1);
          expect(job.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
          for (const group of job.groups.filter(
            (entry) => entry.fallbackMaxWorkers === undefined,
          )) {
            const owner = group.shard_name.replace(/-hosted-\d+$/u, "");
            expect(hostedDeclarations.has(owner), owner).toBe(true);
            const declaredEnv = hostedDeclarations.get(owner);
            expect(group.env).toEqual({
              ...declaredEnv,
              OPENCLAW_VITEST_MAX_WORKERS: String(
                Math.min(2, Number(declaredEnv?.OPENCLAW_VITEST_MAX_WORKERS ?? 2)),
              ),
            });
            if (declaredEnv?.OPENCLAW_VITEST_MAX_WORKERS === undefined) {
              inherited.set(group.shard_name, { ...group, env: declaredEnv });
            }
          }
        }
        return inherited;
      };
      const beforeInherited = inheritedGroupsFor(beforeAdmission);
      const afterInherited = inheritedGroupsFor(afterAdmission);
      const declarationEnv = (
        group: Pick<Group, "shard_name" | "env">,
        plan: typeof before,
        originals: Map<string, Group>,
      ) => {
        const original = originals.get(group.shard_name);
        const job = plan.find((entry) =>
          entry.groups.some((candidate) => candidate.shard_name === group.shard_name),
        );
        if (original && job?.planConcurrency === 1) {
          expect(
            group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? job.env?.OPENCLAW_VITEST_MAX_WORKERS,
          ).toBe("2");
          const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...otherEnv } = group.env ?? {};
          expect(otherEnv).toEqual(original.env ?? {});
          return original.env;
        }
        return group.env;
      };
      const expectPluginPolicy = (plan: typeof after, originals: Map<string, Group>) => {
        expect(
          plan
            .flatMap((job) => job.groups)
            .filter((group) => group.shard_name === "agentic-plugins")
            .map((group) =>
              Object.assign({}, group, { env: declarationEnv(group, plan, originals) }),
            ),
        ).toEqual([
          {
            shard_name: "agentic-plugins",
            configs: ["test/vitest/vitest.plugins.config.ts"],
            includePatterns: ["src/plugins/tools.optional.test.ts"],
            requiresDist: false,
            runner: expect.stringMatching(/^blacksmith-(?:4|8)vcpu-ubuntu-2404$/u),
          },
        ]);
      };
      expectPluginPolicy(after, afterInherited);
      // Keep the transition controls independent of current inventory placement.
      const pluginDeclaration = {
        ...expectDefined(
          afterAdmission
            .flatMap((job) => job.groups)
            .find((group) => group.shard_name === "agentic-plugins"),
          "declared plugin group",
        ),
      };
      const pluginEnv = declarationEnv(pluginDeclaration, afterAdmission, afterInherited);
      if (pluginEnv === undefined) {
        delete pluginDeclaration.env;
      } else {
        pluginDeclaration.env = pluginEnv;
      }
      const pluginAdmission: CompactNodeTestShard = {
        checkName: "plugin-policy-control",
        shardName: "plugin-policy-control",
        groups: [pluginDeclaration],
        requiresDist: false,
        runner: pluginDeclaration.runner,
        planConcurrency: 2,
      };
      const pinnedPlugin: Group = {
        ...pluginDeclaration,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      };
      const promotedPlugin = [{ ...pluginAdmission, groups: [pinnedPlugin], planConcurrency: 1 }];
      const pluginInherited = inheritedGroupsFor([pluginAdmission]);
      expectPluginPolicy(promotedPlugin, pluginInherited);
      const invalidPluginEnvs: Array<Group["env"]> = [
        undefined,
        { OPENCLAW_VITEST_MAX_WORKERS: "1" },
        { OPENCLAW_VITEST_MAX_WORKERS: "3" },
        { OPENCLAW_VITEST_MAX_WORKERS: "2", UNDECLARED_POLICY: "1" },
      ];
      for (const env of invalidPluginEnvs) {
        pinnedPlugin.env = env;
        expect(() => expectPluginPolicy(promotedPlugin, pluginInherited)).toThrow();
      }
      pinnedPlugin.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
      expect(() =>
        expectPluginPolicy(
          promotedPlugin,
          inheritedGroupsFor([{ ...pluginAdmission, planConcurrency: 1 }]),
        ),
      ).toThrow();
      const expectedTimingKeys = (
        parent: string,
        family: Array<{ group: Group; part: number }>,
        plan: typeof before,
        originals: Map<string, Group>,
      ) => {
        const first = expectDefined(family[0], "first timing family entry").group;
        const env = declarationEnv(first, plan, originals);
        return createCompactSplitTimingGeneration({
          parentShardName: parent,
          configs: first.configs,
          env: first.configs.includes("test/vitest/vitest.commands.config.ts")
            ? { ...env, OPENCLAW_VITEST_MAX_WORKERS: "2" }
            : env,
          stripes: family.map(({ group }) => {
            expect(group.configs).toEqual(first.configs);
            expect(declarationEnv(group, plan, originals)).toEqual(env);
            const files = expectDefined(group.includePatterns, "timing family group membership");
            expect(files.length).toBeGreaterThan(0);
            return files;
          }),
        }).timingKeys;
      };
      const expectTimingFamilies = (plan: typeof before, originals: Map<string, Group>) => {
        for (const [parent, family] of timingFamilies(plan)) {
          expect(family.map(({ part }) => part)).toEqual(
            Array.from({ length: family.length }, (_, index) => index + 1),
          );
          expect(
            family.map(({ group }) =>
              group.timing_key?.replace("#file-parallel-8", "#file-parallel-2"),
            ),
          ).toEqual(expectedTimingKeys(parent, family, plan, originals));
        }
      };
      const policies = (plan: typeof before, originals: Map<string, Group>) => {
        const nonPlugin = plan
          .flatMap((shard) => shard.groups)
          .filter((group) => group.shard_name !== "agentic-plugins");
        return {
          descriptors: nonPlugin
            .filter((group) => !isRepartitionableTooling(group))
            .map(({ runner: _runner, ...group }) => {
              if (group.configs.includes("test/vitest/vitest.commands.config.ts")) {
                group.timing_key = group.timing_key?.replace(
                  "#file-parallel-8",
                  "#file-parallel-2",
                );
              }
              const env = declarationEnv(group, plan, originals);
              if (env === undefined) {
                delete group.env;
              } else {
                group.env = env;
              }
              return group;
            })
            .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name)),
          // Allocation may change, but every file must retain its complete execution policy.
          tooling: nonPlugin
            .filter(isRepartitionableTooling)
            .flatMap((group) => {
              const files = expectDefined(
                group.includePatterns,
                "repartitionable tooling membership",
              );
              // A split can move tests out of the compiler's larger runner group.
              expect(group.runner).toBe(
                files.includes("test/scripts/write-unified-entry-dts.test.ts")
                  ? DEFAULT_NODE_TEST_RUNNER
                  : BUNDLED_NODE_TEST_RUNNER,
              );
              return files.map((file) => ({
                parent: toolingParent(group),
                file,
                configs: group.configs,
                env: group.env,
                pretestBuildMode: group.pretestBuildMode,
                requiresDist: group.requiresDist,
                exclusive: isExclusiveCompactShardName(group.shard_name),
              }));
            })
            .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        };
      };
      expectTimingFamilies(before, beforeInherited);
      expectTimingFamilies(after, afterInherited);
      expect(policies(after, afterInherited)).toEqual(policies(before, beforeInherited));
      if (runnerBackend === "hybrid") {
        const serial = structuredClone(before);
        const serialGroup = expectDefined(
          serial
            .filter(
              (job) => job.planConcurrency === 1 && job.env?.OPENCLAW_VITEST_MAX_WORKERS === "2",
            )
            .flatMap((job) => job.groups)
            .find((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined),
          "already-serial group using its job worker cap",
        );
        serialGroup.env = { ...serialGroup.env, OPENCLAW_VITEST_MAX_WORKERS: "2" };
        expect(() =>
          expect(policies(serial, beforeInherited)).toEqual(policies(before, beforeInherited)),
        ).toThrow();
        const promoted = structuredClone(before);
        const recipient = expectDefined(
          promoted.find(
            (job) =>
              job.planConcurrency === 2 &&
              job.groups.some(
                (group) =>
                  group.timing_key &&
                  parseCompactSplitTimingKey(group.timing_key) &&
                  group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined,
              ) &&
              job.groups.every(
                (group) =>
                  group.env?.OPENCLAW_VITEST_MAX_WORKERS !== undefined ||
                  isRuntimePlacementIncludePatterns(group.includePatterns),
              ),
          ),
          "existing parallel recipient with hosted timing parts",
        );
        recipient.planConcurrency = 1;
        recipient.pretestBuildMode = "runtime";
        const keys = recipient.groups.map((group) => group.timing_key);
        for (const group of recipient.groups.filter(
          (entry) => entry.fallbackMaxWorkers === undefined,
        )) {
          group.env = { OPENCLAW_VITEST_MAX_WORKERS: "2", ...group.env };
        }
        expectTimingFamilies(promoted, beforeInherited);
        expect(policies(promoted, beforeInherited)).toEqual(policies(before, beforeInherited));
        expect(recipient.groups.map((group) => group.timing_key)).toEqual(keys);
        recipient.env = { ...recipient.env, OPENCLAW_VITEST_MAX_WORKERS: "2" };
        for (const group of recipient.groups) {
          const original = beforeInherited.get(group.shard_name);
          if (original) {
            group.env = original.env;
          }
        }
        expectTimingFamilies(promoted, beforeInherited);
        expect(policies(promoted, beforeInherited)).toEqual(policies(before, beforeInherited));
        delete recipient.env.OPENCLAW_VITEST_MAX_WORKERS;
        for (const group of recipient.groups.filter(
          (entry) => entry.fallbackMaxWorkers === undefined,
        )) {
          group.env = { OPENCLAW_VITEST_MAX_WORKERS: "2", ...group.env };
        }
        const hosted = expectDefined(
          recipient.groups.find(
            (group) =>
              group.timing_key &&
              parseCompactSplitTimingKey(group.timing_key) &&
              beforeInherited.has(group.shard_name),
          ),
          "hosted recipient group",
        );
        const original = expectDefined(
          beforeInherited.get(hosted.shard_name),
          "original parallel group",
        );
        for (const env of [original.env, { ...original.env, OPENCLAW_VITEST_MAX_WORKERS: "3" }]) {
          if (env === undefined) {
            delete hosted.env;
          } else {
            hosted.env = env;
          }
          expect(() => expectTimingFamilies(promoted, beforeInherited)).toThrow();
          expect(() =>
            expect(policies(promoted, beforeInherited)).toEqual(policies(before, beforeInherited)),
          ).toThrow();
        }
      }
      if (runnerBackend === "github") {
        const regenerateTimingKeys = (plan: typeof before) => {
          for (const [parent, family] of timingFamilies(plan)) {
            const keys = expectedTimingKeys(parent, family, plan, afterInherited);
            family.forEach(({ group }, index) => {
              group.timing_key = expectDefined(keys[index], "regenerated family timing key");
            });
          }
        };
        for (const mutation of ["missing", "duplicated", "env", "runner"] as const) {
          const mutated = structuredClone(after);
          const tooling = mutated.flatMap((shard) => shard.groups).filter(isRepartitionableTooling);
          const target = expectDefined(
            tooling.find(
              (group) =>
                expectDefined(group.includePatterns, "tooling mutation membership").length > 1,
            ),
            "multi-file tooling mutation target",
          );
          const files = expectDefined(target.includePatterns, "tooling mutation target membership");
          if (mutation === "missing") {
            files.pop();
          } else if (mutation === "duplicated") {
            const otherFamily = expectDefined(
              tooling.find((group) => toolingParent(group) !== toolingParent(target)),
              "tooling group from another family",
            );
            files.push(
              expectDefined(
                expectDefined(otherFamily.includePatterns, "other tooling family membership")[0],
                "file from another tooling family",
              ),
            );
          } else if (mutation === "env") {
            for (const { group } of expectDefined(
              timingFamilies(mutated).get(toolingParent(target)),
              "timing family for environment mutation",
            )) {
              group.env = { ...group.env, OPENCLAW_VITEST_MAX_WORKERS: "3" };
            }
          } else {
            target.runner =
              target.runner === BUNDLED_NODE_TEST_RUNNER
                ? DEFAULT_NODE_TEST_RUNNER
                : BUNDLED_NODE_TEST_RUNNER;
          }
          regenerateTimingKeys(mutated);
          expectTimingFamilies(mutated, afterInherited);
          expect(
            () =>
              expect(policies(mutated, afterInherited)).toEqual(policies(before, beforeInherited)),
            `${mutation} must fail policy validation even with valid timing keys`,
          ).toThrow();
        }
        for (const identity of ["parent", "part"] as const) {
          const forged = structuredClone(after);
          const families = timingFamilies(forged);
          const [parent, family] = expectDefined(
            [...families].find(([, entries]) => entries.length >= 2),
            "multi-part timing family for identity control",
          );
          const wrongParent = `${parent}-forged`;
          expect(families.has(wrongParent)).toBe(false);
          const ordered = identity === "part" ? family.toReversed() : family;
          const keys = expectedTimingKeys(
            identity === "parent" ? wrongParent : parent,
            ordered,
            forged,
            afterInherited,
          );
          ordered.forEach(({ group }, index) => {
            group.timing_key = expectDefined(keys[index], "forged family timing key");
          });
          expect(() => expectTimingFamilies(forged, afterInherited)).toThrow(
            identity === "parent"
              ? "timing key parent must match hosted group name"
              : "timing key part must match hosted group ordinal",
          );
        }
        const stale = structuredClone(after);
        const staleGroup = expectDefined(
          stale
            .flatMap((shard) => shard.groups)
            .find(
              (group) =>
                isRepartitionableTooling(group) &&
                expectDefined(group.includePatterns, "stale-key control membership").length > 1,
            ),
          "multi-file tooling group for stale-key control",
        );
        const savedKey = expectDefined(staleGroup.timing_key, "original stale-control timing key");
        expectDefined(staleGroup.includePatterns, "stale-control group membership").pop();
        regenerateTimingKeys(stale);
        expectTimingFamilies(stale, afterInherited);
        staleGroup.timing_key = savedKey;
        expect(
          () => expectTimingFamilies(stale, afterInherited),
          "stale generation key must fail identity",
        ).toThrow();
      }
      expect(
        after.every(
          (shard) =>
            (usesParallelPacking(shard) || shard.groups.length <= 10) &&
            (shard.planConcurrency === 1 ||
              (runnerBackend !== "github" &&
                shard.planConcurrency === 2 &&
                shard.runner === EXTRA_LARGE_NODE_TEST_RUNNER)),
        ),
      ).toBe(true);
      expect(after.length).toBeLessThanOrEqual(90);
    },
  );

  it("splits auto-reply into balanced core/top-level and reply subtree shards", () => {
    const shards = defaultShards;
    const autoReplyShards = shards
      .filter((shard) => shard.shardName.startsWith("auto-reply"))
      .map((shard) => ({
        checkName: shard.checkName,
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        shardName: shard.shardName,
      }));

    expect(autoReplyShards).toEqual([
      {
        checkName: "checks-node-auto-reply-core-top-level",
        configs: [
          "test/vitest/vitest.auto-reply-core.config.ts",
          "test/vitest/vitest.auto-reply-top-level.config.ts",
        ],
        requiresDist: false,
        shardName: "auto-reply-core-top-level",
      },
      {
        checkName: "checks-node-auto-reply-reply-agent-runner",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-agent-runner",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-1",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-1",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-2",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-2",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-3",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-3",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch-core",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch-core",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch-delivery",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch-delivery",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch-lifecycle",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch-lifecycle",
      },
      {
        checkName: "checks-node-auto-reply-reply-session",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-session",
      },
      {
        checkName: "checks-node-auto-reply-reply-state-routing",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-state-routing",
      },
    ]);
  });

  it("covers every auto-reply reply test exactly once across split shards", () => {
    const actual = defaultShards
      .filter((shard) => shard.shardName.startsWith("auto-reply-reply-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listTestFiles("src/auto-reply/reply"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps each dispatch entrypoint in its own dedicated shard", () => {
    const dispatchEntrypoints = new Map([
      ["auto-reply-reply-dispatch-core", "src/auto-reply/reply/dispatch-from-config.test.ts"],
      [
        "auto-reply-reply-dispatch-delivery",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
      ],
      [
        "auto-reply-reply-dispatch-lifecycle",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
      ],
    ]);
    const shards = defaultShards;

    for (const [shardName, entrypoint] of dispatchEntrypoints) {
      expect(shards.find((shard) => shard.shardName === shardName)?.includePatterns).toEqual([
        entrypoint,
      ]);
    }
  });
});
