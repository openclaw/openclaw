import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards,
  hasControlUiPerformanceAffectingChange,
  hasPromptSnapshotAffectingChange,
  hasSqliteSessionLifecycleAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { rebalanceMeasuredSerialJobs } from "../../scripts/lib/ci-measured-compact-packing.mts";
import {
  type CompactNodeTestShard,
  createNodeTestShardBundles,
  createNodeTestShards,
  createSelectedNodeTestShardBundles,
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
  createVitestCacheWarmGroups,
  hasCompleteStartupCorpusCoverage,
  packCompactNodeTestJobsToCapacity,
  resolveCanonicalNodeTestConfig,
  resolveStartupCorpusTestFiles,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  isPolicyTestOwnedPath,
  resolvePolicyTestTargets,
} from "../../scripts/lib/ci-policy-test-watch.mts";
import {
  isCiProofTestFile,
  isReleaseOnlyRuntimeTestFile,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { isExclusiveCiTestConfig } from "../../scripts/lib/local-check-runtime.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  createCompactSplitTimingGeneration,
  parseCompactSplitTimingKey,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  buildVitestRunPlans,
  createVitestRunSpecs,
} from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createAgentsCoreIsolatedVitestConfig } from "../vitest/vitest.agents-core-isolated.config.ts";
import { createAgentsCoreVitestConfig } from "../vitest/vitest.agents-core.config.ts";
import { agentVitestProjectOwners } from "../vitest/vitest.agents-paths.mjs";
import { createAgentsSupportVitestConfig } from "../vitest/vitest.agents-support.config.ts";
import { createAgentsToolsVitestConfig } from "../vitest/vitest.agents-tools.config.ts";
import { createAgentsVitestConfig } from "../vitest/vitest.agents.config.ts";
import { createAutoReplyReplyVitestConfig } from "../vitest/vitest.auto-reply-reply.config.ts";
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
  isGatewayServerTestFile,
} from "../vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "../vitest/vitest.gateway-server.config.ts";
import { createGatewayVitestConfig } from "../vitest/vitest.gateway.config.ts";
import { createInfraVitestConfig } from "../vitest/vitest.infra.config.ts";
import { createPluginSdkLightVitestConfig } from "../vitest/vitest.plugin-sdk-light.config.ts";
import { createPluginSdkVitestConfig } from "../vitest/vitest.plugin-sdk.config.ts";
import { createPluginsVitestConfig } from "../vitest/vitest.plugins.config.ts";
import { createRuntimeConfigVitestConfig } from "../vitest/vitest.runtime-config.config.ts";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import { createToolingVitestConfig } from "../vitest/vitest.tooling.config.ts";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";
import { createUnitFastVitestConfig } from "../vitest/vitest.unit-fast.config.ts";
import { createUnitVitestConfigWithOptions } from "../vitest/vitest.unit.config.ts";
import { createWizardVitestConfig } from "../vitest/vitest.wizard.config.ts";
import {
  createChangedNodeTestShards as createChangedOwnerNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";
import {
  expectRuntimeReleaseInventory,
  isNumberedToolingGroup,
  listMatchedTestFiles,
  listTestFiles,
  nonToolingPlacement,
} from "./ci-node-test-plan.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Control UI release-only inventories", () => {
  const sidebar = "ui/src/components/app-sidebar.stress.browser.test.ts";
  const embed = "ui/src/e2e/native-embed-settings.e2e.test.ts";
  const entry = "ui/src/e2e/chat-session-entry.e2e.test.ts";
  const staleBuild = "ui/src/e2e/control-ui-stale-build-reload.e2e.test.ts";
  const teamScale = "ui/src/e2e/team-scale-cold-load.e2e.test.ts";
  const automationManagement =
    "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts";
  const releaseOnlyRealGateway = new Set([
    "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
    "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
    "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
    automationManagement,
    "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
    "ui/src/e2e/session-pr-reader-lifetime.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-collaborator-scroll.real-gateway.e2e.test.ts",
    "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
    "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
    "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
    "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
    "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  ]);
  function expectRealGatewayCoverage(
    e2eGroups: Parameters<typeof createUiRealGatewayTestShards>[0],
    expectedFiles: readonly string[],
  ) {
    const desktop = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";
    const shards = createUiRealGatewayTestShards(e2eGroups);
    expect(
      shards.map(({ shard, shard_count, run_desktop }) => ({
        shard,
        shard_count,
        run_desktop,
      })),
    ).toEqual([
      { shard: 1, shard_count: 2, run_desktop: expectedFiles.includes(desktop) },
      { shard: 2, shard_count: 2, run_desktop: false },
    ]);
    const files = shards.flatMap((shard) =>
      shard.groups
        .flatMap((group) => {
          expect(group.configs).toEqual(["test/vitest/vitest.ui-e2e-prebuilt.config.ts"]);
          expect(group.includePatterns.length).toBeGreaterThan(0);
          expect(group.includePatterns).not.toContain(desktop);
          return group.includePatterns;
        })
        .concat(shard.run_desktop ? [desktop] : []),
    );
    // Array equality also catches duplicate ownership between jobs or desktop proof.
    expect(files.toSorted()).toEqual(expectedFiles.toSorted());
  }

  it("retains PR-exempt entries while omitting release-only UI matrices", () => {
    const groups = createUiTestShardGroups({ includeReleaseOnlyTests: false });
    expect(groups.ui[0]?.includePatterns).not.toContain(sidebar);
    expect(groups.e2e[0]?.includePatterns).toContain(embed);
    expect(groups.e2e[0]?.includePatterns).toContain(entry);
    expect(groups.e2e[0]?.includePatterns).not.toContain(staleBuild);
    expect(groups.e2e[0]?.includePatterns).not.toContain(teamScale);
    expect(
      uiE2eRealGatewayTestFiles.filter((file) => groups.e2e[0]?.includePatterns?.includes(file)),
    ).toEqual(uiE2eRealGatewayTestFiles.filter((file) => !releaseOnlyRealGateway.has(file)));
    expect(groups.ui[0]?.includePatterns).toContain(
      "ui/src/components/app-sidebar-row-identity.browser.test.ts",
    );
    expect(groups.ui[0]?.includePatterns?.some((file) => file.endsWith(".e2e.test.ts"))).toBe(
      false,
    );
    expectRealGatewayCoverage(
      groups.e2e,
      uiE2eRealGatewayTestFiles.filter((file) => !releaseOnlyRealGateway.has(file)),
    );
  });

  it("retains directly edited release matrices alongside PR-exempt entries", () => {
    const options = {
      includeReleaseOnlyTests: false,
      changedPaths: [
        entry,
        staleBuild,
        teamScale,
        ...releaseOnlyRealGateway,
        "ui/src/components/app-sidebar.ts",
        "ui/src/e2e",
      ],
    };
    const groups = createUiTestShardGroups(options);
    expect(groups.e2e[0]?.includePatterns).toContain(entry);
    expect(groups.e2e[0]?.includePatterns).toContain(staleBuild);
    expect(groups.e2e[0]?.includePatterns).toContain(teamScale);
    expect(
      groups.e2e[0]?.includePatterns?.filter((file) => releaseOnlyRealGateway.has(file)).toSorted(),
    ).toEqual(
      uiE2eRealGatewayTestFiles.filter((file) => releaseOnlyRealGateway.has(file)).toSorted(),
    );
    expect(groups.e2e[0]?.includePatterns).toContain(embed);
    expect(groups.ui[0]?.includePatterns).not.toContain(sidebar);
    expectRealGatewayCoverage(groups.e2e, uiE2eRealGatewayTestFiles);
    expectRealGatewayCoverage(
      createUiTestShardGroups({
        includeReleaseOnlyTests: false,
        changedPaths: [automationManagement, "ui/src/e2e", "ui/src/pages/usage/usage-page.tsx"],
      }).e2e,
      uiE2eRealGatewayTestFiles.filter(
        (file) => !releaseOnlyRealGateway.has(file) || file === automationManagement,
      ),
    );
  });

  it("leaves the complete canonical config inventories in full release validation", () => {
    const groups = createUiTestShardGroups();
    expect(groups).toEqual({
      ui: [{ configs: ["ui/vitest.config.ts"], shard_name: "ui/vitest.config.ts" }],
      e2e: [
        {
          configs: ["test/vitest/vitest.ui-e2e.config.ts"],
          shard_name: "test/vitest/vitest.ui-e2e.config.ts",
        },
      ],
    });
    expectRealGatewayCoverage(groups.e2e, uiE2eRealGatewayTestFiles);
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
  it("certifies only the selected tier and directly edited startup cells", () => {
    const regular = "src/config/config-startup-corpus.test.ts";
    const changed = "src/config/state-startup-corpus.part-2.test.ts";
    const options = { includeReleaseOnlyRuntimeTests: false };
    expect(resolveStartupCorpusTestFiles()).toEqual(files);
    expect(resolveStartupCorpusTestFiles(options)).toEqual([regular]);
    const selected = resolveStartupCorpusTestFiles({
      ...options,
      changedPaths: [changed, "src/config/state-startup-corpus.test-support.ts"],
    });
    expect(selected).toEqual([regular, changed]);
    const shards = [{ requiresDist: false, groups: [{ ...group, includePatterns: selected }] }];
    expect(hasCompleteStartupCorpusCoverage(shards, selected)).toBe(true);
    expect(hasCompleteStartupCorpusCoverage(shards)).toBe(false);
    expect(hasCompleteStartupCorpusCoverage(shards, [])).toBe(false);
    expect(
      hasCompleteStartupCorpusCoverage(
        [{ requiresDist: false, groups: [{ ...group, includePatterns: [regular] }] }],
        selected,
      ),
    ).toBe(false);
  });
  it.each<
    { label: string } & Partial<Parameters<typeof hasCompleteStartupCorpusCoverage>[0][number]>
  >([{ label: "target precedence", groups: [group], targets: files.slice(0, 1) }])(
    "does not certify $label",
    ({ label: _label, ...shard }) => {
      expect(hasCompleteStartupCorpusCoverage([{ requiresDist: false, ...shard }])).toBe(false);
    },
  );
});

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
const STORE_ALIAS_CHANGED_PATHS = [
  "docs/gateway/secrets.md",
  "src/agents/auth-profiles/read-only-availability.test.ts",
  "src/agents/auth-profiles/read-only-availability.ts",
  "src/agents/model-auth-availability.test.ts",
  "src/plugins/manifest-tool-availability.test.ts",
  "src/plugins/manifest-tool-availability.ts",
  "src/plugins/tools.optional.test.ts",
];
function selectFixtureProjects(owns: (config: string) => boolean) {
  const original = fullSuiteVitestShards.slice();
  fullSuiteVitestShards.splice(
    0,
    fullSuiteVitestShards.length,
    ...original
      .map((shard) => ({ ...shard, projects: shard.projects.filter(owns) }))
      .filter((shard) => shard.projects.length > 0),
  );
  return () => {
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
  };
}

describe("scripts/lib/ci-node-test-plan.mts", () => {
  it("keeps the scheduled main inventory within its reserved compact capacity", () => {
    const jobs = createNodeTestShardBundles({
      includeProofTests: true,
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyToolingShards: true,
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: true,
      compactMode: "pull-request",
      compactNodeJobCap: 76,
      runnerBackend: "hybrid",
    });
    // Main's 77 Node rows reserve one for the separate worker-E2E owner.
    expect(jobs.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(76);
    expect(jobs.length).toBeLessThanOrEqual(78);
  });

  function smallCapacityJobs(count: number): CompactNodeTestShard[] {
    return Array.from({ length: count }, (_, index) => ({
      checkName: `checks-capacity-${index}`,
      shardName: `capacity-${index}`,
      requiresDist: false,
      runner: "blacksmith-8vcpu-ubuntu-2404",
      planConcurrency: 1,
      predictedSeconds: 10,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      groups: [
        {
          shard_name: `capacity-${index}`,
          requiresDist: false,
          runner: "blacksmith-8vcpu-ubuntu-2404",
          configs: ["test/vitest/vitest.hooks.config.ts"],
          includePatterns: [`src/hooks/capacity-${index}.test.ts`],
        },
      ],
    }));
  }

  const capacityOptions = {
    compactJobCap: 78,
    runnerBackend: "hybrid",
    estimateGroupSeconds: () => 10,
  };

  it("fits 83 small compatible bundles under the capacity ceiling without losing or duplicating files", () => {
    const before = smallCapacityJobs(83);
    const after = packCompactNodeTestJobsToCapacity(before, capacityOptions);
    expect(after).toHaveLength(78);
    expect(
      after.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!)).toSorted(),
    ).toEqual(
      Array.from({ length: 83 }, (_, index) => `src/hooks/capacity-${index}.test.ts`).toSorted(),
    );
    expect(after.filter((job) => job.groups.length > 1)).toHaveLength(5);
    for (const job of after) {
      expect(job.predictedSeconds).toBeLessThanOrEqual(210);
      expect(job.groups.length).toBeLessThanOrEqual(10);
      for (const group of job.groups) {
        expect(before.flatMap((entry) => entry.groups)).toContain(group);
      }
    }
    expect(
      packCompactNodeTestJobsToCapacity(before, { ...capacityOptions, compactJobCap: 83 }),
    ).toBe(before);
  });

  it("retries hybrid Gateway-first packing only when the completed plan exceeds its cap", () => {
    const entries = [
      ["ordinary-a", "hooks", 180],
      ["ordinary-b", "hooks", 180],
      ["ordinary-c", "hooks", 160],
      ["gateway-constrained", "gateway-core", 120],
      ["ordinary-d", "hooks", 120],
      ["ordinary-e", "hooks", 30],
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
      const options = {
        compactMode: "push",
        runnerBackend: "hybrid",
        includeReleaseOnlyPluginShards: false,
      } as const;
      const originalJobs = createNodeTestShardBundles(options);
      expect(originalJobs).toHaveLength(3);
      expect(
        originalJobs.find((job) =>
          job.groups.some((group) => group.shard_name === "gateway-constrained"),
        ),
      ).toMatchObject({ planConcurrency: 1, predictedSeconds: 280 });
      const jobs = createNodeTestShardBundles({ ...options, compactNodeJobCap: 2 });
      // Cost-first packing spends 280s on Gateway and strands 510s of ordinary
      // work across two rows; admitting Gateway first leaves one 490s parallel row.
      expect(jobs).toHaveLength(2);
      const gateway = expectDefined(
        jobs.find((job) => job.groups.some((group) => group.shard_name === "gateway-constrained")),
        "Gateway job",
      );
      expect(gateway).toMatchObject({
        planConcurrency: 1,
        predictedSeconds: 300,
        predictedTestSeconds: 300,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      });
      const ordinary = expectDefined(
        jobs.find((job) => job !== gateway),
        "ordinary job",
      );
      expect(ordinary).toMatchObject({
        planConcurrency: 2,
        predictedSeconds: 490,
        predictedTestSeconds: 280,
      });
      expect(jobs.every((job) => job.runner === EXTRA_LARGE_NODE_TEST_RUNNER)).toBe(true);
      expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual(
        entries.map(([name]) => name).toSorted(),
      );
      expect(() => createNodeTestShardBundles({ ...options, compactNodeJobCap: 1 })).toThrow(
        "compact hybrid node test plan exceeds 1 jobs (2 planned)",
      );
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
    }
  });

  // Read-only cases share this baseline; inventory and timing mutations build fresh plans.
  let defaultShards: ReturnType<typeof createNodeTestShards>;

  // Only unchanged committed inputs share snapshots; every caller receives its own graph.
  const committedCompactPlans = new Map<string, CompactNodeTestShard[]>();
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

  afterAll(() => {
    committedCompactPlans.clear();
  });

  it.each(["pull-request"] as const)(
    "retains child policies while routing RunsOn from measured hybrid %s plans",
    (compactMode) => {
      const hybrid = getCommittedCompactPlan(compactMode, "hybrid");
      const runson = getCommittedCompactPlan(compactMode, "runson");
      const routed = runson.filter((job) => job.runner === "runson-c8i-8xlarge");
      expect(routed).toHaveLength(1);
      expect(routed[0]).toMatchObject({
        planConcurrency: 1,
        requiresDist: false,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      });
      expect(routed[0]!.pretestBuildMode).toBeUndefined();
      const cronGroups = routed[0]!.groups;
      expect(cronGroups.map((group) => group.shard_name).toSorted()).toEqual([
        "core-runtime-cron-parallel-core",
        "core-runtime-cron-parallel-isolated-agent",
        "core-runtime-cron-parallel-service",
      ]);
      const cronNames = new Set(cronGroups.map((group) => group.shard_name));
      const previousCronJobs = hybrid.filter((job) =>
        job.groups.some((group) => cronNames.has(group.shard_name)),
      );
      expect(routed[0]!.timeoutMinutes).toBe(
        Math.min(...previousCronJobs.map((job) => job.timeoutMinutes ?? 60)),
      );
      const orderedGroups = (jobs: CompactNodeTestShard[]) =>
        jobs
          .flatMap((job) => job.groups)
          .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
      // Coverage and the complete executor contract survive the provider move.
      expect(orderedGroups(runson)).toEqual(orderedGroups(hybrid));
      expect(runson.filter((job) => job.runner !== "runson-c8i-8xlarge")).toEqual(
        hybrid
          .flatMap((job) => {
            const groups = job.groups.filter((group) => !cronNames.has(group.shard_name));
            return groups.length ? [{ ...job, groups }] : [];
          })
          .toSorted((a, b) => a.checkName.localeCompare(b.checkName)),
      );
      expect(runson.length).toBeLessThanOrEqual(90);
      expect(
        createNodeTestShardBundles({
          includeReleaseOnlyPluginShards: false,
          compactMode,
          runnerBackend: "hybrid",
        }),
      ).toEqual(hybrid);
    },
  );

  // Frozen executor inputs keep measurement regression tests independent of
  // unrelated inventory additions. Only a new native observation updates them.
  const measuredCompactFixture = JSON.parse(
    readFileSync(new URL("./fixtures/ci-measured-compact-jobs.json", import.meta.url), "utf8"),
  ) as {
    toolingJobs: CompactNodeTestShard[];
    cliTailJob: CompactNodeTestShard;
    cliChildJobWallSeconds: number[];
    toolingTailJobs: CompactNodeTestShard[];
  };

  function measuredToolingFixture(): CompactNodeTestShard[] {
    return structuredClone(measuredCompactFixture.toolingJobs);
  }

  const measuredPackingOptions = {
    runner: DEFAULT_NODE_TEST_RUNNER,
    estimateGroup: () => ({ seconds: 0, complete: false }),
    canShare: (groups: CompactNodeTestShard["groups"]) => {
      const families = groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, ""));
      return groups.length <= 10 && new Set(families).size === families.length;
    },
  };
  const sortedMeasuredGroups = (jobs: CompactNodeTestShard[]) =>
    jobs.flatMap((job) => job.groups).toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));

  it("packs hosted hourly tooling only with complete supplied prices and ignores native tails", () => {
    const tooling = measuredToolingFixture()
      .slice(0, 2)
      .map((job) => Object.assign({}, job, { predictedSeconds: 220 }));
    const cli = structuredClone(measuredCompactFixture.cliTailJob);
    const options = {
      ...measuredPackingOptions,
      profile: "hosted-hourly" as const,
      estimateGroup: () => ({ seconds: 220, complete: false }),
    };
    const unmeasured = rebalanceMeasuredSerialJobs([...tooling, cli], options);
    expect(unmeasured).toHaveLength(3);
    expect(unmeasured).toContainEqual(cli);
    const packed = rebalanceMeasuredSerialJobs([...tooling, cli], {
      ...options,
      estimateGroup: () => ({ seconds: 220, complete: true }),
    });
    expect(packed).toHaveLength(2);
    expect(packed).toContainEqual(cli);
    expect(sortedMeasuredGroups(packed)).toEqual(sortedMeasuredGroups([...tooling, cli]));
    expect(packed.every((job) => job.planConcurrency === 1)).toBe(true);
    expect(packed.every((job) => job.timeoutMinutes === 20)).toBe(true);
    expect(packed.find((job) => job !== cli)?.predictedSeconds).toBe(440);
    const native = rebalanceMeasuredSerialJobs(tooling, {
      ...options,
      profile: "native",
      estimateGroup: () => ({ seconds: 220, complete: true }),
    });
    expect(native).toHaveLength(2);
    expect(native.every((job) => job.predictedSeconds === 220)).toBe(true);
  });

  it.each(measuredCompactFixture.toolingTailJobs.slice(0, 1))(
    "splits observed tooling pair $shardName without transferring runtime preparation",
    (fixture) => {
      const before = structuredClone(fixture);
      const after = rebalanceMeasuredSerialJobs([before], measuredPackingOptions);
      expect(after).toHaveLength(2);
      expect(after.flatMap((job) => job.groups)).toEqual(before.groups);
      for (const [index, job] of after.entries()) {
        expect(job).toMatchObject({
          runner: before.runner,
          planConcurrency: before.planConcurrency,
          requiresDist: before.requiresDist,
        });
        expect(job.env).toEqual(before.env);
        expect(job.timeoutMinutes).toBe(before.timeoutMinutes);
        expect(job.pretestBuildMode).toBe(before.groups[index]!.pretestBuildMode);
        expect(job.predictedSeconds).toBeGreaterThanOrEqual(before.predictedSeconds!);
      }
    },
  );

  it("does not spend serial tooling observations after the workers contract changes", () => {
    const before = measuredToolingFixture();
    before.forEach((job) => {
      job.env = { OPENCLAW_VITEST_MAX_WORKERS: "1" };
    });
    expect(rebalanceMeasuredSerialJobs(before, measuredPackingOptions)).toEqual(before);
  });

  it("preserves distinct job deadlines when considering measured tooling packing", () => {
    const before = measuredToolingFixture();
    before.forEach((job, index) => {
      job.timeoutMinutes = 14 + index;
    });
    const after = rebalanceMeasuredSerialJobs(before, measuredPackingOptions);
    expect(after).toHaveLength(10);
    const deadlines = (jobs: CompactNodeTestShard[]) =>
      jobs
        .flatMap((job) => job.groups.map((group) => ({ group, timeout: job.timeoutMinutes })))
        .toSorted((a, b) => a.group.shard_name.localeCompare(b.group.shard_name));
    expect(deadlines(after)).toEqual(deadlines(before));
  });

  it("counts every placement stage against the compact cap", () => {
    const options = {
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request" as const,
      runnerBackend: "runson",
    };
    const stages = ["hybrid", "runson"].map((profile) =>
      getCommittedCompactPlan(options.compactMode, profile),
    );
    const compactNodeJobCap = Math.max(
      ...stages.map((jobs) => jobs.filter((job) => !job.requiresDist).length),
    );
    expect(createNodeTestShardBundles({ ...options, compactNodeJobCap })).toEqual(stages[1]);
    expect(() =>
      createNodeTestShardBundles({ ...options, compactNodeJobCap: compactNodeJobCap - 1 }),
    ).toThrow(/compact (?:hybrid|runson) node test plan exceeds/u);
  });

  it("keeps precise RunsOn targets and their canonical child policies", () => {
    const cronTarget = "src/cron/validate-timestamp.test.ts";
    const siblingTarget = "src/cli/update-dry-run-state.process.test.ts";
    const cliTarget = "src/cli/nodes-cli.coverage.test.ts";
    const targets = [cronTarget, siblingTarget, cliTarget];
    const hybrid = expectDefined(
      createSelectedNodeTestShardBundles(targets, { runnerBackend: "hybrid" }),
      "precise hybrid plan",
    );
    const runson = expectDefined(
      createSelectedNodeTestShardBundles(targets, { runnerBackend: "runson" }),
      "precise RunsOn plan",
    );
    const orderedGroups = (jobs: CompactNodeTestShard[]) =>
      jobs
        .flatMap((job) => job.groups)
        .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
    expect(orderedGroups(runson)).toEqual(orderedGroups(hybrid));
    expect(
      orderedGroups(runson)
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted(),
    ).toEqual(targets.toSorted());
    expect(runson.filter((job) => job.runner === "runson-c8i-8xlarge")).toMatchObject([
      { groups: [{ includePatterns: [cronTarget] }], planConcurrency: 1 },
    ]);
    expect(
      runson.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(siblingTarget)),
      )?.runner,
    ).toBe(
      hybrid.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(siblingTarget)),
      )?.runner,
    );
    expect(
      runson.find((job) => job.groups.some((group) => group.includePatterns?.includes(cliTarget)))
        ?.runner,
    ).toBe("blacksmith-16vcpu-ubuntu-2404");
  });

  it.each(["hybrid"])(
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
          runnerBackend === "blacksmith" ? 240 : runnerBackend === "hybrid" ? 435 : 440,
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
          expect(predicted(childMeasured)).toBe(runnerBackend === "hybrid" ? 405 : 410);
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
          runnerBackend === "github" ? 124 : runnerBackend === "hybrid" ? 85 : 88,
        );
        seconds[`${commands}-parallel`] = 200;
        const projectedRuntimeJob = createPlan(options).find((job) =>
          job.groups.some((group) => group.includePatterns?.includes(runtimeFile)),
        );
        expect(projectedRuntimeJob?.predictedSeconds).toBe(runnerBackend === "github" ? 141 : 105);
        const runtimeGroup = projectedRuntimeJob!.groups.find((group) =>
          group.includePatterns?.includes(runtimeFile),
        )!;
        expect(runtimeGroup.includePatterns).toEqual([runtimeFile]);
        seconds[runtimeGroup.timing_key!] = 10;
        const refitted = createPlan(options).find((job) =>
          job.groups.some((group) => group.includePatterns?.includes(runtimeFile)),
        );
        // An exact parallel sample replaces the migrated serial observation.
        expect(refitted?.predictedSeconds).toBe(runnerBackend === "github" ? 106 : 70);
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

  it("retains each singleton auto-reply stripe's full cost when splitting a parallel parent", () => {
    const config = "test/vitest/vitest.auto-reply-reply.config.ts";
    const owner = "auto-reply-reply-state-routing";
    const files = expectDefined(
      defaultShards.find((shard) => shard.shardName === owner)?.includePatterns,
      "mutable planner inventory fixture",
    );
    const originalFiles = files.slice();
    const restore = selectFixtureProjects((candidate) => candidate === config);
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
      restore();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches policy owners with literal and native glob semantics", () => {
    const changedPath = "ui/src/styles/base.css";
    expect(isPolicyTestOwnedPath(changedPath)).toBe(true);
    expect(resolvePolicyTestTargets([changedPath])).not.toEqual([]);
    expect(resolvePolicyTestTargets([changedPath], { completeOwnersOnly: true })).toEqual([
      "ui/src/styles/base-theme-tokens.node.test.ts",
      "ui/src/styles/base-theme-contrast.node.test.ts",
      "ui/src/styles/cursor-policy.node.test.ts",
    ]);
    expect(
      resolvePolicyTestTargets(["ui/public/themes/tide.css"], { completeOwnersOnly: true }),
    ).toEqual([
      "ui/src/styles/base-theme-tokens.node.test.ts",
      "ui/src/styles/base-theme-contrast.node.test.ts",
    ]);
    expect(isPolicyTestOwnedPath("ui/public/themes/tide.css")).toBe(true);
    expect(isPolicyTestOwnedPath("ui/src/styles/./base.css")).toBe(true);
    expect(
      resolvePolicyTestTargets(["ui/src/styles/./base.css"], { completeOwnersOnly: true }),
    ).toEqual([
      "ui/src/styles/base-theme-tokens.node.test.ts",
      "ui/src/styles/base-theme-contrast.node.test.ts",
      "ui/src/styles/cursor-policy.node.test.ts",
    ]);
    expect(
      resolvePolicyTestTargets(["ui/src/pages/chat/view.ts"], { completeOwnersOnly: true }),
    ).toEqual([]);
    for (const lookalike of [` ${changedPath}`, String.raw`ui\src\pages\chat\view.ts`]) {
      expect(isPolicyTestOwnedPath(lookalike), lookalike).toBe(false);
      expect(resolvePolicyTestTargets([lookalike]), lookalike).toEqual([]);
    }
  });

  it("bounds the hybrid hosted seed to real consumer configs without runtime builds", () => {
    const groups = createVitestCacheWarmGroups("hybrid-hosted");
    expect(groups).toHaveLength(7);

    expect(groups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
    const files = groups.flatMap((group) => group.includePatterns ?? []);
    expect(files).toHaveLength(16);
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

  it.each([{ profile: "hybrid", legacy: 101, measured: 310, defaultSeconds: 22, preparation: 60 }])(
    "prefers $profile measurements while retaining unmeasured hints and defaults",
    ({ profile, legacy, measured, defaultSeconds, preparation }) => {
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
      expect(tuiJob(fallback)?.pretestBuildMode).toBe("runtime");
      expect(tuiJob(fallback)?.predictedSeconds).toBe(legacy + preparation);
      timings.mockImplementation((runner) => ({
        "core-runtime-tui-pty": runner === "blacksmith" ? 310 : 370,
        "removed-test-group": 999,
      }));
      const updated = createNodeTestShardBundles(options);
      expect(tuiJob(updated)?.groups.map((group) => group.shard_name)).toEqual([
        "core-runtime-tui-pty",
      ]);
      expect(tuiJob(updated)?.predictedSeconds).toBe(measured + preparation);
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
      const restore = selectFixtureProjects((config) => fixtureConfigs.has(config));
      try {
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
        expect(packed[0]?.predictedSeconds).toBe(groupSeconds * 2);
      } finally {
        restore();
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

  it.each([
    {
      owner: "core-runtime-config",
      config: "test/vitest/vitest.runtime-config.config.ts",
      suite: "core-runtime",
      root: "src/config",
      pinned: true,
      runnerBackend: "hybrid",
    },
    {
      owner: "agentic-agents-support",
      config: agentVitestProjectOwners.support.config,
      suite: "agentic",
      root: "src/agents",
      pinned: false,
      runnerBackend: "blacksmith",
    },
  ])(
    "preserves the measured worker policy when splitting $owner",
    async ({ owner, config, suite, root, pinned, runnerBackend }) => {
      // The support owner selects subdirectories; top-level files belong to agents-core.
      const files = Array.from(
        { length: 70 },
        (_, index) => `${root}/fixture/entry-${String(index).padStart(3, "0")}.test.ts`,
      );
      const timings: Record<string, number> = { [owner]: 240 };
      vi.resetModules();
      vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
        fullSuiteVitestShards: [{ name: suite, config, projects: [config] }],
      }));
      vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
        listTrackedTestFiles: (candidate: string) => (candidate === root ? files : []),
      }));
      vi.doMock("../../scripts/lib/ci-node-test-inventory.mts", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../scripts/lib/ci-node-test-inventory.mts")>()),
        listWholeConfigSplitFiles: (candidate: string) => (candidate === owner ? files : undefined),
      }));
      vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
        ...testTimings,
        readCompactGroupTimings: () => timings,
        readRuntimePlacementTimings: () => [],
      }));
      vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
        ...(await importOriginal<
          typeof import("../../scripts/lib/vitest-build-prerequisites.mts")
        >()),
        resolveVitestPretestBuildMode: () => undefined,
      }));
      try {
        const { createNodeTestShardBundles: createPlan } =
          await import("../../scripts/lib/ci-node-test-plan.mts");
        const options = { compactMode: "push" as const, runnerBackend };
        const before = createPlan(options);
        const [observed, sibling] = before.flatMap((job) => job.groups);
        expect(before.flatMap((job) => job.groups)).toHaveLength(2);
        expect(observed?.includePatterns).toHaveLength(35);
        const timingKey = observed!.timing_key!;
        timings[timingKey] = 362;
        const after = createPlan(options);
        const groups = after.flatMap((job) => job.groups);
        expect(groups.flatMap((group) => group.includePatterns!).toSorted()).toEqual(files);
        expect(groups.find((group) => group.timing_key === sibling!.timing_key)).toEqual(sibling);
        if (!pinned) {
          const measuredJob = expectDefined(
            after.find((job) => job.groups.some((group) => group.timing_key === timingKey)),
            "unpinned measured child",
          );
          expect(measuredJob.groups).toEqual([observed]);
          expect(measuredJob.predictedTestSeconds).toBeGreaterThanOrEqual(362);
          expect(measuredJob.planConcurrency).toBe(1);
          expect(measuredJob.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
          expect(measuredJob.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
          expect(observed?.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
          return;
        }
        const descendants = groups.filter((group) =>
          parseCompactSplitTimingKey(group.timing_key!)?.parentShardName.startsWith(timingKey),
        );
        expect(descendants.length).toBeGreaterThan(1);
        expect(descendants.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
          observed!.includePatterns!.toSorted(),
        );
        expect(descendants.every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2")).toBe(
          true,
        );
        expect(after.every((job) => job.predictedTestSeconds! <= 300)).toBe(true);
        const totalSeconds = after.reduce((total, job) => total + job.predictedSeconds!, 0);
        expect(totalSeconds).toBeGreaterThanOrEqual(482);
        expect(totalSeconds).toBeLessThan(487);
        expect(createPlan(options)).toEqual(after);
        delete timings[timingKey];
        timings[timingKey.replace(/#generation-[^#]+/u, "#generation-000000000000")] = 362;
        expect(createPlan(options)).toEqual(after);

        const nestedKey = descendants[0]!.timing_key!;
        timings[nestedKey] = 3_600;
        const singleton = createPlan(options)
          .flatMap((job) => job.groups)
          .find(
            (group) =>
              group.timing_key?.startsWith(nestedKey) && group.includePatterns?.length === 1,
          );
        expect(singleton).toBeDefined();
        timings[singleton!.timing_key!] = 500;
        const indivisible = createPlan(options).find((job) =>
          job.groups.some((group) => group.timing_key === singleton!.timing_key),
        );
        expect(indivisible?.groups).toHaveLength(1);
        expect(indivisible?.predictedTestSeconds).toBeGreaterThanOrEqual(500);
      } finally {
        vi.doUnmock("../../scripts/lib/vitest-build-prerequisites.mts");
        vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
        vi.doUnmock("../../scripts/lib/ci-node-test-inventory.mts");
        vi.doUnmock("../../scripts/lib/list-test-files.mts");
        vi.doUnmock("../vitest/vitest.test-shards.mjs");
        vi.resetModules();
      }
    },
  );

  it("retains the caught Codex recovery contract in main, PR, and manual Node plans", () => {
    const proofFiles = ["src/gateway/server.codex-failure-recovery.test.ts"];
    const files = (mode: "push" | "pull-request") =>
      getCommittedCompactPlan(mode).flatMap((shard) =>
        shard.groups.flatMap((group) => group.includePatterns ?? []),
      );
    const mainFiles = files("push");
    const prFiles = files("pull-request");
    const manual = createNodeTestShards({ includeProofTests: false });
    for (const file of proofFiles) {
      expect(mainFiles.filter((target) => target === file)).toHaveLength(1);
      expect(prFiles.filter((target) => target === file)).toHaveLength(1);
      const rawConfig = expectDefined(buildVitestRunPlans([file])[0]?.config, file);
      const config = resolveCanonicalNodeTestConfig(file, rawConfig) ?? rawConfig;
      expect(
        manual.filter(
          (shard) =>
            shard.configs.includes(config) &&
            (!shard.includePatterns ||
              shard.includePatterns.some((pattern) => matchesGlob(file, pattern))),
        ),
      ).toHaveLength(1);
      expect(isCiProofTestFile(file)).toBe(false);
    }
    const isolated = expectDefined(
      manual.find((shard) => shard.shardName === "agentic-gateway-server-isolated"),
      "manual isolated Gateway owner",
    );
    expect(isolated.configs).toContain("test/vitest/vitest.gateway-server-isolated.config.ts");
    expect(
      isolated.includePatterns ?? listMatchedTestFiles(createGatewayServerIsolatedVitestConfig({})),
    ).toContain("src/gateway/server.chat-recovered-output.test.ts");
  });

  it.each(["github"])(
    "defers exactly the runtime release inventory from automatic plans on %s",
    (runnerBackend) => {
      const reducedOwners = defaultShards
        .filter(
          (shard) =>
            shard.shardName === "core-runtime-config" ||
            shard.shardName === "agentic-cli" ||
            shard.includePatterns?.some(isReleaseOnlyRuntimeTestFile),
        )
        .map((shard) => shard.shardName);
      for (const compactMode of ["push", "pull-request"] as const) {
        const before = getCommittedCompactPlan(compactMode, runnerBackend);
        const after = createNodeTestShardBundles({
          compactMode,
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
          includeReleaseOnlyRuntimeTests: false,
          changedPaths: ["src/config/state-startup-corpus.test-support.ts"],
        });
        expectRuntimeReleaseInventory({ before, after, reducedOwners, compactMode });
      }
    },
  );

  it("keeps noncompact reduced runtime bundles separate from release timing history", () => {
    const full = createNodeTestShardBundles();
    const reduced = createNodeTestShardBundles({ includeReleaseOnlyRuntimeTests: false });
    for (const config of [
      "test/vitest/vitest.runtime-config.config.ts",
      "test/vitest/vitest.infra.config.ts",
      "test/vitest/vitest.unit-src.config.ts",
    ]) {
      expect(
        full.filter((shard) => shard.configs.includes(config)).some((shard) => shard.timing_key),
      ).toBe(false);
      const owners = reduced.filter((shard) => shard.configs.includes(config) && shard.timing_key);
      expect(owners.length, config).toBeGreaterThan(0);
      for (const owner of owners) {
        const key = expectDefined(owner.timing_key, "reduced bundle timing identity");
        expect(parseCompactSplitTimingKey(key)?.parentShardName ?? key).toBe(
          `changed-${owner.shardName}`,
        );
      }
    }
  });

  it("allocates sparse selections without reserving their full-suite rows", async () => {
    const heavyCli = "src/cli/gateway-backed-exit-health.process.test.ts";
    const targets = [
      "src/config/allowed-values.test.ts",
      "src/commands/doctor-heartbeat-cadence-migration.test.ts",
      "src/infra/heartbeat-runner.ack-token-heartbeat-acks.test.ts",
      "src/infra/runtime-guard.test.ts",
      heavyCli,
      "src/cli/directory-cli.test.ts",
      "src/config/config.backup-rotation.test.ts",
      "src/config/commands.test.ts",
    ];
    const configs = {
      infra: "test/vitest/vitest.infra.config.ts",
      config: "test/vitest/vitest.runtime-config.config.ts",
      commands: "test/vitest/vitest.commands.config.ts",
      cli: "test/vitest/vitest.cli-process.config.ts",
    };
    const fillers = (prefix: string, count = 9) =>
      Array.from({ length: count }, (_, index) => `${prefix}.fixture-${index}.test.ts`);
    const configFiles = [
      ...targets.filter((file) => file.startsWith("src/config/")),
      ...fillers("src/config/fixture", 15),
    ];
    const cliFiles = [heavyCli, "src/cli/directory-cli.test.ts", ...fillers("src/cli/fixture", 8)];
    const infraFiles = [
      ...targets.filter((file) => file.startsWith("src/infra/")),
      ...fillers("src/infra/heartbeat-runner"),
      ...fillers("src/infra/runtime-guard"),
      ...fillers("src/infra/os-summary", 10),
      ...fillers("src/infra/provider-usage", 10),
      ...fillers("src/infra/channel-runtime-context", 10),
      ...fillers("src/infra/diagnostic-trace-context", 10),
    ];
    const commandFiles = [targets[1]!, ...fillers("src/commands/doctor-heartbeat-cadence")];
    const inventory = [...configFiles, ...cliFiles, ...infraFiles, ...commandFiles];
    const timings: Record<string, number> = {
      "core-runtime-config": 240,
      "core-runtime-infra-heartbeat-runner": 170,
      "core-runtime-infra-system-runtime": 160,
      "core-runtime-infra-misc-os": 170,
      "core-runtime-infra-provider-push": 160,
      "core-runtime-infra-channel-plugin": 150,
      "core-runtime-infra-diagnostics-state": 150,
      "agentic-cli-process": 240,
      "agentic-commands-doctor-sessions-cron": 120,
    };
    vi.resetModules();
    vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
      fullSuiteVitestShards: [
        { name: "core-runtime", config: configs.infra, projects: [configs.infra, configs.config] },
        { name: "agentic", config: configs.commands, projects: [configs.commands, configs.cli] },
      ],
    }));
    vi.doMock("../vitest/vitest.database-worker-core-paths.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.database-worker-core-paths.mjs")>()),
      databaseWorkerCoreTestFiles: [],
      isDatabaseWorkerCoreTestFile: () => false,
    }));
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (root: string) =>
        inventory.filter((file) => file.startsWith(`${root}/`)),
    }));
    vi.doMock("../../scripts/lib/ci-node-test-inventory.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/ci-node-test-inventory.mts")>()),
      listWholeConfigFiles: (owner: string) =>
        owner === "core-runtime-config"
          ? configFiles
          : owner === "agentic-cli-process"
            ? cliFiles
            : undefined,
      listWholeConfigSplitFiles: (owner: string) =>
        owner === "core-runtime-config"
          ? configFiles
          : owner === "agentic-cli-process"
            ? cliFiles
            : undefined,
      listNodeTestConfigFiles: (config: string) =>
        ({
          [configs.infra]: infraFiles,
          [configs.config]: configFiles,
          [configs.commands]: commandFiles,
          [configs.cli]: cliFiles,
        })[config],
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
      ...testTimings,
      readCompactGroupTimings: () => timings,
      readRuntimePlacementTimings: () => [],
    }));
    try {
      const {
        createNodeTestShardBundles: createBundles,
        createSelectedNodeTestShardBundles: createSelected,
      } = await import("../../scripts/lib/ci-node-test-plan.mts");
      const options = {
        runnerBackend: "hybrid",
        includeReleaseOnlyRuntimeTests: false,
      } satisfies NonNullable<Parameters<typeof createSelected>[1]>;
      let full = createBundles({
        ...options,
        includeReleaseOnlyPluginShards: false,
        compactMode: "pull-request",
      });
      const heavyGroup = expectDefined(
        full
          .flatMap((job) => job.groups)
          .find((group) => group.includePatterns?.includes(heavyCli)),
        "indivisible CLI timing fixture",
      );
      timings[heavyGroup.timing_key!] = 200;
      full = createBundles({
        ...options,
        includeReleaseOnlyPluginShards: false,
        compactMode: "pull-request",
      });
      const owners = full.filter((job) =>
        job.groups.some((group) => group.includePatterns?.some((file) => targets.includes(file))),
      );
      expect(owners.length).toBeGreaterThan(1);
      const selected = createSelected(targets, options)!;
      expect(selected).not.toBeNull();
      expect(selected.length).toBeLessThan(owners.length);
      expect(
        selected
          .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
          .toSorted(),
      ).toEqual(targets.toSorted());
      expect(
        selected.every((job) => job.groups.every((group) => group.includePatterns!.length > 0)),
      ).toBe(true);
      expect(selected.reduce((sum, job) => sum + job.predictedSeconds!, 0)).toBeLessThan(
        owners.reduce((sum, job) => sum + job.predictedSeconds!, 0),
      );
      const heavyJob = selected.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(heavyCli)),
      )!;
      expect(heavyJob.predictedSeconds).toBeGreaterThan(150);
      expect(heavyJob.groups.flatMap((group) => group.includePatterns ?? [])).toEqual([heavyCli]);
      for (const job of selected) {
        expect(job.predictedTestSeconds).toBeGreaterThan(0);
        expect(job.predictedTestSeconds).toBeLessThanOrEqual(job.predictedSeconds!);
        if (job.planConcurrency === 2) {
          expect(job.predictedTestSeconds).toBeLessThanOrEqual(300);
          expect(
            job.groups.filter((group) => group.shard_name.startsWith("core-runtime-config-hosted-"))
              .length,
          ).toBeLessThanOrEqual(1);
        }
        for (const group of job.groups) {
          const original = full.find((owner) =>
            owner.groups.some((entry) => entry.shard_name === group.shard_name),
          )!;
          expect(job).toMatchObject({
            runner: original.runner,
            planConcurrency: original.planConcurrency,
            requiresDist: original.requiresDist,
          });
          expect(job.pretestBuildMode).toBe(original.pretestBuildMode);
          expect(job.timeoutMinutes).toBe(original.timeoutMinutes);
          expect(job.env).toEqual(original.env);
          const owner = original.groups.find((entry) => entry.shard_name === group.shard_name)!;
          expect(group.env).toEqual(owner.env);
          expect(group.fallbackMaxWorkers).toBe(owner.fallbackMaxWorkers);
          expect(group.minTotalMemoryBytes).toBe(owner.minTotalMemoryBytes);
        }
      }
    } finally {
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/ci-node-test-inventory.mts");
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.database-worker-core-paths.mjs");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.resetModules();
    }
  });

  async function createToolingFixturePlan(params: {
    files: string[];
    shards: typeof fullSuiteVitestShards;
    timings: Record<string, number>;
    fileSeconds: (file: string) => number;
    options: {
      compactMode: "push" | "pull-request";
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
      // These fixtures exercise a caller's 90-row reservation independently
      // of the profile ceiling; explicit tighter reservations remain authoritative.
      return createPlan({
        ...params.options,
        compactNodeJobCap: params.options.compactNodeJobCap ?? 90,
      });
    } finally {
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/vitest-shard-metadata.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.doUnmock("../vitest/vitest.unit-fast-paths.mjs");
      vi.resetModules();
    }
  }

  it("keeps hosted tooling within the GitHub job cap when its inventory grows", async () => {
    // Seventy-eight full-budget anchors leave 12 of the 90 jobs for tooling.
    const anchors = Array.from({ length: 78 }, (_, index) => ({
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
      compactNodeJobCap?: number,
      shortFileSeconds = 23,
    ) => {
      return createToolingFixturePlan({
        files: [...fixtureFiles, ...(includeGrowthFile ? [inventoryGrowthFile] : [])],
        shards: fixtureShards,
        timings: fixtureTimings,
        // Mixed costs keep the 300s tooling budget under the same 90-row pressure.
        // One tail donation still makes the tighter cap feasible.
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

    const budgeted = await createPlanWithInventory(true, 89);
    expect(budgeted.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(89);
    expect(nonToolingPlacement(budgeted)).toEqual(nonToolingPlacement(grown));
    expect(
      budgeted
        .flatMap((job) => job.groups)
        .filter(isNumberedToolingGroup)
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted(),
    ).toEqual(toolingFiles.toSorted());

    // Eleven 300s tooling rows cannot hold 160 ordinary 25s files plus the
    // compiler at the hosted worker price. Preserve that infeasible-case refusal.
    await expect(createPlanWithInventory(true, 89, 25)).rejects.toThrow(
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
        expect(job.predictedSeconds).toBeLessThanOrEqual(
          job.pretestBuildMode ? 210 : job.groups.every(isHostedToolingGroup) ? 300 : 150,
        );
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
        "src/gateway/github-publication-transcript.test.ts",
        "src/gateway/mcp-http.session-controls.test.ts",
        "src/gateway/mcp-http.test.ts",
        "src/gateway/server-worker-placement-session-evidence.test.ts",
        "src/gateway/server-worker-placement-session-evidence.worker.test.ts",
        "src/gateway/session-lifecycle-run-failure.test.ts",
        "src/gateway/session-lifecycle-state.persistence.test.ts",
        "src/gateway/talk/client-permission-parity.test.ts",
        "src/gateway/tool-resolution.swarm-collector.test.ts",
        "src/gateway/tool-resolution.terminal.test.ts",
        "src/gateway/worker-workspace-recovery-transcript.test.ts",
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
      "src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.test.ts",
      "src/agents/sandbox.context.github-identity.test.ts",
      "src/auto-reply/reply/session-reset-prompt.test.ts",
      "src/agents/prepared-model-runtime.hot-reload-dispatch.test.ts",
      "src/agents/subagents/registry/subagent-registry.session-failure.test.ts",
      "src/plugin-sdk/session-transcript-runtime.test.ts",
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
        createAutoReplyReplyVitestConfig({}),
        createPluginSdkLightVitestConfig({}),
        createPluginSdkVitestConfig({}),
        createPluginsVitestConfig({}),
        createToolingVitestConfig({}),
        createWizardVitestConfig({}),
        createCommandsVitestConfig({}),
        createRuntimeConfigVitestConfig({}),
        createGatewayVitestConfig({}),
        createGatewayCoreVitestConfig({}),
        createGatewayClientVitestConfig({}),
        createGatewayMethodsVitestConfig({}),
        createGatewayMethodsIsolatedVitestConfig({}),
        createGatewayServerVitestConfig({}),
        createGatewayServerIsolatedVitestConfig({}),
        createGatewayDatabaseWorkersVitestConfig({}),
      ].flatMap(listMatchedTestFiles),
    );
    for (const file of databaseWorkerCoreTestFiles) {
      expect(admitted.has(file), file).toBe(true);
      expect(former.has(file), file).toBe(false);
    }
    const gatewayWorkerFiles = databaseWorkerCoreTestFiles.filter((file) =>
      file.startsWith("src/gateway/"),
    );
    const gatewayPlanFiles = defaultShards
      .filter((shard) => shard.shardName.startsWith("agentic-gateway-core"))
      .flatMap((shard) => shard.includePatterns ?? []);
    expect(gatewayPlanFiles.filter((file) => gatewayWorkerFiles.includes(file))).toEqual([]);
    const infraPlanFiles = defaultShards
      .filter((shard) => shard.configs.includes("test/vitest/vitest.infra.config.ts"))
      .flatMap((shard) => shard.includePatterns ?? []);
    expect(infraPlanFiles.filter((file) => gatewayWorkerFiles.includes(file)).toSorted()).toEqual(
      gatewayWorkerFiles.toSorted(),
    );
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

  it.each(["github"])(
    "prices parallel cron from serial work until %s has direct measurements",
    (runnerBackend) => {
      const restore = selectFixtureProjects(
        (config) => config === "test/vitest/vitest.cron.config.ts",
      );
      try {
        const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({
          "core-runtime-cron-core": 40,
          "core-runtime-cron-isolated-agent": 100,
          "core-runtime-cron-service": 140,
        });
        const options = { compactMode: "pull-request" as const, runnerBackend };
        const baseline = createNodeTestShardBundles(options);
        const totalSeconds = (plan: typeof baseline) =>
          plan.reduce((total, job) => total + job.predictedSeconds!, 0);
        expect(totalSeconds(baseline)).toBe(140);
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
        expect(totalSeconds(measured)).toBe(160);
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
        restore();
      }
    },
  );

  it("keeps the complete tooling family in manual plans and omits it from product plans", () => {
    const automatic = createNodeTestShards({ includeReleaseOnlyToolingShards: false });
    const hasTooling = (shards: typeof automatic) =>
      shards.some((shard) => shard.shardName.startsWith("core-tooling-"));
    expect(hasTooling(defaultShards)).toBe(true);
    expect(hasTooling(automatic)).toBe(false);
    const files = automatic.flatMap((shard) => shard.includePatterns ?? []);
    expect(files.some((file) => file.startsWith("test/scripts/"))).toBe(false);
    expect(files).toContain("src/infra/home-dir.test.ts");
  });

  it("retains the changed host plugin test in a bounded hub plan beside store aliases", () => {
    const target = "src/plugins/tools.optional.test.ts";
    const changedPaths = [...STORE_ALIAS_CHANGED_PATHS, "tsconfig.json"];
    const onFallback = vi.fn();
    const changedShards = createChangedNodeTestShards(changedPaths, { onFallback });
    expect(changedShards).not.toBeNull();
    expect(onFallback).not.toHaveBeenCalled();
    expect(
      changedShards?.flatMap((shard) =>
        (shard.targets ?? []).concat(
          (shard.groups ?? [shard]).flatMap((group) => group.includePatterns ?? []),
        ),
      ),
    ).toContain(target);
    const options = {
      changedPaths,
      includeReleaseOnlyPluginShards: false,
    };
    const shards = createNodeTestShards(options);
    expect(shards.filter((shard) => shard.shardName === "agentic-plugins")).toEqual([
      {
        checkName: "checks-node-agentic-plugins",
        shardName: "agentic-plugins",
        configs: ["test/vitest/vitest.plugins.config.ts"],
        includePatterns: [target],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
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
});

describe("CI changed Node test plan", () => {
  it.each([
    ["ui/src/main.ts", true],
    // Erased TSX header imports do not bring Gateway server code into the UI runtime.
    ["packages/gateway-client/src/index.ts", false],
  ] as const)("selects UI performance for %s: %s", (file, expected) => {
    expect(hasControlUiPerformanceAffectingChange([file])).toBe(expected);
  });

  it("classifies prompt-snapshot impact by surface and generator import graph", () => {
    // Inside the generator's import graph -> regenerated output can change.
    expect(hasPromptSnapshotAffectingChange(["src/auto-reply/reply/prompt-prelude.ts"])).toBe(true);
    // The codex extension loads through a dynamic bundled-plugin module id the
    // graph walk cannot see; it stays on the always-run surface.
    expect(hasPromptSnapshotAffectingChange(["extensions/codex/src/index.ts"])).toBe(true);
    expect(
      hasPromptSnapshotAffectingChange([
        "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/README.md",
      ]),
    ).toBe(true);
    expect(hasPromptSnapshotAffectingChange(["scripts/generate-prompt-snapshots.ts"])).toBe(true);
    // Workspace packages feed the generator through package-specifier imports
    // the relative graph walk cannot see.
    expect(hasPromptSnapshotAffectingChange(["packages/llm-core/src/index.ts"])).toBe(true);
    // The gate's own orchestration must not be able to skip the gated lane.
    expect(hasPromptSnapshotAffectingChange([".github/workflows/ci.yml"])).toBe(true);
    expect(hasPromptSnapshotAffectingChange(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(
      true,
    );
    // Outside the surface and the generator graph -> the lane may skip.
    expect(hasPromptSnapshotAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["extensions/discord/src/index.ts"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["docs/index.md"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["test/scripts/ci-node-test-plan.test.ts"])).toBe(
      false,
    );
    // Deleted source files cannot be graphed; fail safe to running the check.
    expect(hasPromptSnapshotAffectingChange(["src/infra/definitely-deleted-module.ts"])).toBe(true);
  });

  it("classifies SQLite session lifecycle impact by owner and import graph", () => {
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/agents/embedded-agent-runner/run/attempt-session-runtime-prepare.ts",
      ]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/gateway/server-methods/sessions.ts"]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/sessions/session-lifecycle-admission.ts"]),
    ).toBe(true);
    expect(hasSqliteSessionLifecycleAffectingChange(["src/config/sessions.ts"])).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
      ]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "packages/media-understanding-common/src/provider-id.ts",
      ]),
    ).toBe(false);
    expect(hasSqliteSessionLifecycleAffectingChange(["src/agents/model-auth.ts"])).toBe(false);
    expect(hasSqliteSessionLifecycleAffectingChange(["extensions/discord/src/index.ts"])).toBe(
      false,
    );
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/config/sessions/session-registry-maintenance.test.ts",
      ]),
    ).toBe(false);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/infra/definitely-deleted-module.ts"]),
    ).toBe(false);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/agents/embedded-agent-runner/run/deleted-session-runtime.ts",
      ]),
    ).toBe(true);
  });

  describe("release fast lane", () => {
    it("keeps compact packing policy and runtime inputs bounded", () => {
      const onFallback = vi.fn();
      createChangedOwnerNodeTestShards(
        ["scripts/lib/ci-node-test-plan.mts", "test/scripts/ci-node-test-plan.test.ts"],
        { runnerBackend: "blacksmith", onFallback },
      );
      expect(onFallback).not.toHaveBeenCalledWith(
        "compact packing policy requires full-plan proof",
      );
      const globalPlan = createChangedOwnerNodeTestShards(["scripts/run-vitest.mts"], {
        onFallback,
      });
      expect(globalPlan).not.toBeNull();
      expect(selectedFiles(globalPlan)).toContain("test/scripts/test-projects.test.ts");
      expect(selectedFiles(globalPlan)).not.toContain("src/cron/service.stream-trigger.test.ts");
      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  it("fails safe for raw Git paths that resemble normalized script paths", () => {
    for (const changedPath of [
      " scripts/changed-lanes.mts",
      String.raw`scripts\changed-lanes.mts`,
    ]) {
      expect(createChangedOwnerNodeTestShards([changedPath]), changedPath).toBeNull();
    }
  });
});
