import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { rebalanceMeasuredSerialJobs } from "../../scripts/lib/ci-measured-compact-packing.mts";
import * as nodeTestInventory from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  type CompactNodeTestShard,
  createNodeTestShardBundles,
  createNodeTestShards,
  createSelectedNodeTestShardBundles,
  createUiRealGatewayTestShards,
  createUiTestShardGroups,
  createVitestCacheWarmGroups,
  hasCompleteStartupCorpusCoverage,
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
import * as proofTestInventory from "../../scripts/lib/ci-proof-test-inventory.mts";
import { createNativeSoloTimingKey } from "../../scripts/lib/ci-test-timings-schema.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { isExclusiveCiTestConfig } from "../../scripts/lib/local-check-runtime.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { listVitestRuntimeConsumerFiles } from "../../scripts/lib/vitest-build-prerequisites.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  createCompactSplitTimingGeneration,
  parseCompactSplitTimingKey,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  buildVitestRunPlans,
  createVitestRunSpecs,
} from "../../scripts/test-projects.test-support.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";
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
import { createAutoReplyReplyVitestConfig } from "../vitest/vitest.auto-reply-reply.config.ts";
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
  gatewayServerSerialTestFiles,
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
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTimerTestFiles,
} from "../vitest/vitest.unit-fast-paths.mjs";
import { createUnitFastVitestConfig } from "../vitest/vitest.unit-fast.config.ts";
import { createUnitVitestConfigWithOptions } from "../vitest/vitest.unit.config.ts";
import { createWizardVitestConfig } from "../vitest/vitest.wizard.config.ts";
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
        ...releaseOnlyRealGateway,
        "ui/src/components/app-sidebar.ts",
        "ui/src/e2e",
      ],
    };
    const groups = createUiTestShardGroups(options);
    expect(groups.e2e[0]?.includePatterns).toContain(entry);
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
        changedPaths: [automationManagement, "ui/src/e2e", "ui/src/pages/usage/usage-page.ts"],
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
  >([
    { label: "unknown full config", groups: [{ ...group, includePatterns: undefined }] },
    { label: "different config", groups: [{ ...group, configs: ["vitest.config.ts"] }] },
    {
      label: "native shard",
      groups: [{ ...group, env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]' } }],
    },
    { label: "target precedence", groups: [group], targets: files.slice(0, 1) },
    { label: "non-admitted dist row", groups: [group], requiresDist: true },
  ])("does not certify $label", ({ label: _label, ...shard }) => {
    expect(hasCompleteStartupCorpusCoverage([{ requiresDist: false, ...shard }])).toBe(false);
  });
});

const PLUGIN_PRERELEASE_NPM_SPEC_TEST = "src/plugins/install.npm-spec.test.ts";
const RELEASE_REPORT_OWNER_TEST = "test/scripts/vitest-report-owner.test.ts";
const PRIVATE_QA_TOOLING_TEST = "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts";
const MEASURED_STORAGE_RECOVERY_TEST =
  "src/agents/main-session-recovery/main-session-restart-recovery.test.ts";
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
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

  it("rejects parallel bins whose ordered queue exceeds the test budget", () => {
    const entries = [170, 170, 160, 160, 150, 150].map(
      (seconds, index) => [`ordinary-${index}`, seconds] as const,
    );
    vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(Object.fromEntries(entries));
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
      // The tempting 170 + 170 + 160 bin fits 500 aggregate seconds but takes 330 on two slots.
      expect(jobs.every((job) => job.predictedTestSeconds! <= 300)).toBe(true);
      expect(jobs.map((job) => job.planConcurrency)).toEqual([2, 2, 2]);
      expect(jobs.reduce((sum, job) => sum + job.predictedSeconds!, 0)).toBe(960);
      expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual(
        entries.map(([name]) => name).toSorted(),
      );
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
      ["agentic-agents-embedded-base-13", 150],
      ["core-unit-src-security-12", 150],
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
        predictedTestSeconds: 110,
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
        predictedSeconds: 270,
        env: undefined,
      });
      expect(gateway?.predictedSeconds).toBeLessThanOrEqual(300);
      expect(gateway?.groups.map((group) => group.shard_name)).toEqual([
        "agentic-agents-core-runtime",
        "agentic-gateway-server-isolated",
      ]);
      expect(gateway?.groups.map((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS)).toEqual([
        "2",
        "2",
      ]);
      const parallelJobs = jobs.filter((job) => job !== gateway);
      expect(parallelJobs.map((job) => job.planConcurrency)).toEqual([2, 2]);
      for (const job of parallelJobs) {
        expect(job.predictedSeconds).toBeLessThanOrEqual(500);
        expect(
          job.groups.every((group) =>
            [undefined, "2"].includes(group.env?.OPENCLAW_VITEST_MAX_WORKERS),
          ),
        ).toBe(true);
      }
      expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual(
        entries.map(([name]) => name).toSorted(),
      );
      expect(jobs.reduce((sum, job) => sum + job.predictedSeconds!, 0)).toBe(
        entries.reduce((sum, entry) => sum + entry[2], 0),
      );
      expect(jobs).toHaveLength(3);
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

  it("packs within 300 test seconds while retaining indivisible native-wall outliers", () => {
    const before = measuredToolingFixture();
    const after = rebalanceMeasuredSerialJobs(before, measuredPackingOptions);
    expect(after).toHaveLength(10);
    expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
    expect(Math.max(...after.map((job) => job.predictedSeconds!))).toBe(351);
    expect(
      after.filter((job) => job.groups.length > 1).every((job) => job.predictedSeconds! <= 300),
    ).toBe(true);
    expect(
      after.filter((job) => job.predictedSeconds! > 300).every((job) => job.groups.length === 1),
    ).toBe(true);
    expect(after.every((job) => job.planConcurrency === 1 && job.timeoutMinutes === 20)).toBe(true);
    expect(
      after.every(
        (job) =>
          job.env?.OPENCLAW_VITEST_MAX_WORKERS === "2" ||
          job.groups.every((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2"),
      ),
    ).toBe(true);
  });

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

  it.each([
    { tailSeconds: 460, tailRunner: DEFAULT_NODE_TEST_RUNNER, expectedJobs: 1 },
    { tailSeconds: 461, tailRunner: DEFAULT_NODE_TEST_RUNNER, expectedJobs: 2 },
    { tailSeconds: 460, tailRunner: BUNDLED_NODE_TEST_RUNNER, expectedJobs: 2 },
  ])(
    "preserves hosted runner anchors and the serial budget with a $tailSeconds-second $tailRunner tail",
    ({ tailSeconds, tailRunner, expectedJobs }) => {
      const before = measuredToolingFixture().slice(0, 2);
      const anchor = before[0]!;
      const tail = before[1]!;
      anchor.predictedSeconds = 200;
      tail.runner = tailRunner;
      tail.groups[0]!.runner = tailRunner;
      tail.predictedSeconds = tailSeconds;
      const after = rebalanceMeasuredSerialJobs(before, {
        ...measuredPackingOptions,
        runner: DEFAULT_NODE_TEST_RUNNER,
        profile: "hosted-hourly",
        estimateGroup: (group) => ({
          seconds: group === anchor.groups[0] ? 200 : tailSeconds,
          complete: true,
        }),
      });

      expect(after).toHaveLength(expectedJobs);
      expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
      expect(Math.max(...after.map((job) => job.predictedSeconds!))).toBeLessThanOrEqual(720);
      expect(after.every((job) => job.planConcurrency === 1 && job.timeoutMinutes === 20)).toBe(
        true,
      );
      if (expectedJobs === 1) {
        expect(after[0]).toMatchObject({
          checkName: tail.checkName,
          shardName: tail.shardName,
          runner: DEFAULT_NODE_TEST_RUNNER,
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
          predictedSeconds: 660,
        });
        expect(after[0]!.predictedSeconds! + 60).toBe(720);
      }
    },
  );

  it("splits the observed CLI pair with its measured wall floors and complete child contracts", () => {
    const before = structuredClone(measuredCompactFixture.cliTailJob);
    const after = rebalanceMeasuredSerialJobs([before], measuredPackingOptions);
    expect(after).toHaveLength(2);
    expect(after.flatMap((job) => job.groups)).toEqual(before.groups);
    expect(new Set(after.map((job) => job.checkName)).size).toBe(2);
    for (const [index, job] of after.entries()) {
      expect(job).toMatchObject({
        runner: before.runner,
        planConcurrency: before.planConcurrency,
        requiresDist: before.requiresDist,
        timeoutMinutes: before.timeoutMinutes,
      });
      expect(job.env).toEqual(before.env);
      expect(job.pretestBuildMode).toBeUndefined();
      // The fixture records complete job walls, including 60s of setup.
      expect(job.predictedSeconds).toBe(measuredCompactFixture.cliChildJobWallSeconds[index]! - 60);
    }
  });

  it.each(measuredCompactFixture.toolingTailJobs)(
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

  it.each(["runner", "workers", "concurrency"] as const)(
    "does not spend serial tooling observations after the %s contract changes",
    (change) => {
      const before = measuredToolingFixture();
      if (change === "runner") {
        before.forEach((job) => {
          job.runner = EXTRA_LARGE_NODE_TEST_RUNNER;
        });
      } else if (change === "workers") {
        before.forEach((job) => {
          job.env = { OPENCLAW_VITEST_MAX_WORKERS: "1" };
        });
      } else if (change === "concurrency") {
        before.forEach((job) => {
          job.planConcurrency = 2;
        });
      }
      expect(rebalanceMeasuredSerialJobs(before, measuredPackingOptions)).toEqual(before);
    },
  );

  it("reprices changed selectors without spending their expired native observation", () => {
    const observed = measuredToolingFixture().find((job) =>
      job.groups.some((group) => group.shard_name === "core-tooling-7-hosted-1"),
    )!;
    const options = {
      ...measuredPackingOptions,
      estimateGroup: () => ({ seconds: 200, complete: true }),
    };
    expect(rebalanceMeasuredSerialJobs([observed], options)[0]!.predictedSeconds).toBe(276);
    const changed = structuredClone(observed);
    changed.groups[0]!.includePatterns!.push("test/scripts/unmeasured-fixture.test.ts");
    const after = rebalanceMeasuredSerialJobs([changed], options);
    expect(after[0]!.predictedSeconds).toBe(200);
    expect(after[0]!.groups).toEqual(changed.groups);
  });

  it("splits observed pairs above 300 test seconds without discounting their canonical prices", () => {
    const before = measuredToolingFixture()[7]!;
    const after = rebalanceMeasuredSerialJobs([before], {
      ...measuredPackingOptions,
      estimateGroup: (group) => ({
        seconds: group.shard_name === "core-tooling-12-hosted-1" ? 218 : 351,
        complete: true,
      }),
    });
    expect(after).toHaveLength(2);
    expect(after.flatMap((job) => job.groups)).toEqual(before.groups);
    expect(after.map((job) => job.predictedSeconds)).toEqual([218, 351]);
  });

  it("splits newly expensive tooling pairs after their historical timing identities expire", () => {
    const before = structuredClone(measuredCompactFixture.toolingTailJobs[1]!);
    before.groups.forEach((group, index) => {
      group.timing_key = `unmeasured-child-${index}`;
      group.includePatterns!.push(`test/scripts/unmeasured-fixture-${index}.test.ts`);
    });
    const after = rebalanceMeasuredSerialJobs([before], {
      ...measuredPackingOptions,
      estimateGroup: () => ({ seconds: 320, complete: true }),
    });
    expect(after).toHaveLength(2);
    expect(after.flatMap((job) => job.groups)).toEqual(before.groups);
    expect(after.map((job) => job.predictedSeconds)).toEqual([320, 320]);
  });

  it("does not pack an unmeasured file using the canonical fallback as a wall observation", () => {
    const before = measuredToolingFixture().slice(0, 2);
    before.forEach((job, index) => {
      job.groups[0]!.includePatterns!.push(`test/scripts/unmeasured-fixture-${index}.test.ts`);
      job.predictedSeconds = 80;
    });
    const estimateGroup = () => ({ seconds: 80, complete: false });
    const after = rebalanceMeasuredSerialJobs(before, { ...measuredPackingOptions, estimateGroup });
    expect(after).toHaveLength(2);
    expect(after.map((job) => job.groups)).toEqual(before.map((job) => job.groups));
    expect(after.map((job) => job.predictedSeconds)).toEqual([80, 80]);
    expect(
      rebalanceMeasuredSerialJobs(before, {
        ...measuredPackingOptions,
        estimateGroup: () => ({ seconds: 80, complete: true }),
      }),
    ).toHaveLength(1);
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

  it.each(["job", "file"] as const)(
    "does not replace a higher %s price with a faster measured tooling wall",
    (source) => {
      const before = measuredToolingFixture();
      if (source === "job") {
        before[0]!.predictedSeconds = 900;
      }
      const after = rebalanceMeasuredSerialJobs(before, {
        ...measuredPackingOptions,
        estimateGroup: (group) => ({
          seconds: source === "file" && group.shard_name === "core-tooling-1" ? 900 : 0,
          complete: source === "file" && group.shard_name === "core-tooling-1",
        }),
      });
      const expensive = expectDefined(
        after.find((job) => job.checkName === before[0]!.checkName),
        "expensive owner",
      );
      expect(expensive.groups).toEqual(before[0]!.groups);
      expect(expensive.predictedSeconds).toBe(900);
      expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
    },
  );

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
    const targets = [cronTarget, siblingTarget];
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
      const { createSelectedNodeTestShardBundles } = await import("./scripts/lib/ci-node-test-plan.mts");
      const importReads = sourceReads;
      const plan = createSelectedNodeTestShardBundles([
        "test/scripts/managed-child-process.test.ts",
        "test/scripts/test-projects.test.ts",
      ], { runnerBackend: "github" });
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
      distOwners: [],
      selected: [
        "test/scripts/managed-child-process.test.ts",
        "test/scripts/test-projects.test.ts",
      ],
    });
  });

  it.each([
    { runnerBackend: "blacksmith", serialEstimate: 53, parallelEstimate: 24, indivisible: true },
    { runnerBackend: "github", serialEstimate: 80, parallelEstimate: 24 },
  ])(
    "prices parallel agent files once across $runnerBackend timing refits ($serialEstimate s fallback)",
    ({ runnerBackend, serialEstimate, parallelEstimate, indivisible = false }) => {
      const restore = selectFixtureProjects((config) =>
        indivisible
          ? embeddedAgentVitestProjectOwners.some((owner) => owner.config === config)
          : config === agentVitestProjectOwners.tools.config,
      );
      try {
        const owner = "agentic-agents-tools";
        const pricedFile = "src/agents/embedded-agent-runner/pricing-heavy.test.ts";
        if (indivisible) {
          const listFiles = nodeTestInventory.listNodeTestConfigFiles;
          vi.spyOn(nodeTestInventory, "listNodeTestConfigFiles").mockImplementation((config) =>
            config === agentVitestProjectOwners.embedded.config
              ? [
                  pricedFile,
                  "src/agents/embedded-agent-runner/pricing-light-a.test.ts",
                  "src/agents/embedded-agent-runner/pricing-light-b.test.ts",
                ]
              : listFiles(config),
          );
          const fileSeconds = shardMetadata.estimateVitestTestFileSeconds;
          vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockImplementation((file) =>
            file === pricedFile ? 53 : fileSeconds(file),
          );
        }
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
                  ? group.includePatterns?.includes(pricedFile)
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
        restore();
      }
    },
  );

  it.each(["hybrid", "github"])(
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

  it.each([undefined, "8"])(
    "retains isolated Gateway timing history (previous workers=%s)",
    (previousWorkers) => {
      const owner = "agentic-gateway-server-isolated";
      const configs = [
        "test/vitest/vitest.gateway-server-isolated.config.ts",
        "test/vitest/vitest.gateway-database-workers.config.ts",
      ];
      const restore = selectFixtureProjects((config) => configs.includes(config));
      try {
        const previous: Record<string, number> = { [owner]: 100 };
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) =>
          profile === "blacksmith" ? previous : { [owner]: 100 },
        );
        const options = { compactMode: "push" as const, runnerBackend: "hybrid" };
        const initial = createNodeTestShardBundles(options).flatMap((job) => job.groups);
        expect(initial.map((group) => group.env?.OPENCLAW_VITEST_MAX_WORKERS)).toEqual(["2", "2"]);
        const legacy = createCompactSplitTimingGeneration({
          configs,
          env: previousWorkers ? { OPENCLAW_VITEST_MAX_WORKERS: previousWorkers } : undefined,
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
          expanded
            .flatMap((job) => job.groups.flatMap((group) => group.includePatterns!))
            .toSorted(),
        ).toEqual(initial.flatMap((group) => group.includePatterns!).toSorted());
      } finally {
        restore();
      }
    },
  );

  it.each(["hybrid", "github"])(
    "gates Gateway method workers without changing complete coverage (%s)",
    (runnerBackend) => {
      const owner = "agentic-gateway-methods";
      const configs = new Set([
        "test/vitest/vitest.gateway-methods.config.ts",
        "test/vitest/vitest.gateway-methods-isolated.config.ts",
      ]);
      const restore = selectFixtureProjects((config) => configs.has(config));
      const timings: Record<string, number> = { [owner]: 120 };
      vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
      vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      try {
        const jobs = createNodeTestShardBundles({
          compactMode: "push",
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
          includeReleaseOnlyRuntimeTests: true,
        });
        const groups = jobs.flatMap((job) => job.groups);
        expect(groups.length).toBeGreaterThan(0);
        expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
          [
            ...listMatchedTestFiles(createGatewayMethodsVitestConfig({})),
            ...listMatchedTestFiles(createGatewayMethodsIsolatedVitestConfig({})),
          ].toSorted(),
        );
        for (const job of jobs) {
          expect(job.planConcurrency).toBe(1);
          if (runnerBackend !== "github") {
            expect(job.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
            expect(job.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
          }
          for (const group of job.groups) {
            const measured = runnerBackend !== "github";
            expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe(measured ? "4" : "2");
            expect(group.minTotalMemoryBytes).toBe(measured ? 28 * 1024 ** 3 : undefined);
            expect(group.fallbackMaxWorkers).toBe(measured ? 2 : undefined);
            expect(group.timing_key?.includes("#workers-4") ?? false).toBe(measured);
          }
        }
        if (runnerBackend !== "github") {
          const fullFiles = groups.flatMap((group) => group.includePatterns ?? []);
          const excluded = expectDefined(fullFiles[0], "Gateway method release-only fixture");
          vi.spyOn(proofTestInventory, "isReleaseOnlyRuntimeTestFile").mockImplementation(
            (file) => file === excluded,
          );
          vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
          for (const [key, seconds] of [
            [owner, 1023],
            [`changed-${owner}`, 800],
            [`${owner}#workers-4`, 600],
            [`changed-${owner}#workers-4`, 400],
          ] as const) {
            timings[key] = seconds;
            const reduced = createNodeTestShardBundles({
              compactMode: "pull-request",
              runnerBackend,
              includeProofTests: true,
              includeReleaseOnlyPluginShards: false,
              includeReleaseOnlyRuntimeTests: false,
            });
            const predicted = reduced.reduce(
              (sum, job) => sum + expectDefined(job.predictedSeconds, "Gateway prediction"),
              0,
            );
            expect(predicted, key).toBeGreaterThanOrEqual(seconds);
            expect(predicted, key).toBeLessThan(seconds + reduced.length);
            expect(
              reduced
                .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
                .toSorted(),
            ).toEqual(fullFiles.filter((file) => file !== excluded).toSorted());
          }
        }
      } finally {
        restore();
      }
    },
  );

  it.each([
    {
      owner: "agentic-gateway-core-2",
      config: "test/vitest/vitest.gateway-core.config.ts",
      previousWorkers: "2",
    },
  ])(
    "retains complete $owner timing floors and ignores partial generations",
    ({ owner, config, previousWorkers }) => {
      const restore = selectFixtureProjects((candidate) => candidate === config);
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
        restore();
      }
    },
  );

  it.each([
    { profile: "blacksmith", owner: "auto-reply-reply-state-routing", fallback: 60, measured: 99 },
    { profile: "hybrid", owner: "auto-reply-reply-state-routing", fallback: 52, measured: 99 },
    { profile: "blacksmith", owner: "auto-reply-reply-dispatch-core", fallback: 120, measured: 99 },
  ])(
    "prices $owner on $profile at two workers without discounting new measurements",
    ({ profile, owner, fallback, measured }) => {
      const config = "test/vitest/vitest.auto-reply-reply.config.ts";
      const restore = selectFixtureProjects((candidate) => candidate === config);
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
        restore();
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

  it.each(["github"])(
    "prices serial Gateway server measurements at two workers and preserves parallel samples (%s)",
    (runnerBackend) => {
      const config = "test/vitest/vitest.gateway-server.config.ts";
      const owner = "agentic-control-plane-agent-chat";
      const restore = selectFixtureProjects((candidate) => candidate === config);
      try {
        const timings: Record<string, number> = { [owner]: 540 };
        vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(timings);
        vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
        const options = { compactMode: "pull-request" as const, runnerBackend };
        const select = (includeReleaseOnlyRuntimeTests = true) =>
          createNodeTestShardBundles({ ...options, includeReleaseOnlyRuntimeTests })
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
        timings[parallelParent] = 440;
        const measured = select();
        expect(measured).toHaveLength(3);
        expect(measured.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
          inherited.flatMap((group) => group.includePatterns!).toSorted(),
        );
        const reduced = select(false);
        expect(reduced).toHaveLength(measured.length);
        expect(reduced.flatMap((group) => group.includePatterns!).toSorted()).toEqual(
          measured
            .flatMap((group) => group.includePatterns!)
            .filter((file) => !isReleaseOnlyRuntimeTestFile(file))
            .toSorted(),
        );
        expect(
          reduced.map((group) => parseCompactSplitTimingKey(group.timing_key!)?.parentShardName),
        ).toEqual(reduced.map(() => `changed-${parallelParent}`));
        timings[`changed-${owner}-parallel-native-serial`] = 180;
        expect(select(false).length).toBeLessThan(reduced.length);
        expect(select()).toEqual(measured);
      } finally {
        restore();
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
      // One runtime preparation costs 60s; both singleton files retain their serial floor.
      expect(seconds()).toBe(260);
      // Two 300s files still cost 300s each when a 300s parallel parent is split.
      timings[`${owner}-parallel`] = 300;
      expect(seconds()).toBe(660);
      delete timings[`${owner}-parallel`];
      for (const key of keys) {
        timings[key] = 300;
      }
      expect(seconds()).toBe(660);
      timings[parent] = 600;
      expect(seconds()).toBe(660);
      for (const key of keys) {
        delete timings[key];
      }
      expect(seconds()).toBe(660);
      for (const key of keys) {
        timings[key] = 300;
      }
      timings[parent] = 400;
      expect(seconds()).toBe(660);
      delete timings[parent];
      for (const key of keys) {
        timings[key] = 30;
      }
      expect(seconds()).toBe(120);
      timings[parent] = 700;
      expect(seconds()).toBe(120);
    } finally {
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.resetModules();
    }
  });

  it.each(["github"])("keeps oversized sparse groups nonempty on %s", (runnerBackend) => {
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
      const restore = selectFixtureProjects((config) => target.configs.includes(config));
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
        restore();
      }
    },
  );
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("selects provisioning and closure guards without replacing source test owners", () => {
    const guards = [
      // Provisioning inspects templates through the fork-owned SQLite broker.
      ["test/scripts/pr-worktree-provision.test.ts", "test/vitest/vitest.infra.config.ts"],
      ["test/scripts/eager-import-closure.test.ts", "test/vitest/vitest.tooling.config.ts"],
    ] as const;
    const manifest = "scripts/pr-lib/wrapper-components.txt";
    for (const changedPath of [
      "scripts/pr",
      "scripts/pr-lib/worktree.sh",
      "src/plugins/discovery.ts",
      "src/plugins/discovery-availability.ts",
    ]) {
      const targets = resolvePolicyTestTargets([changedPath]);
      for (const [guard] of guards) {
        expect(targets, changedPath).toContain(guard);
      }
      expect(isPolicyTestOwnedPath(changedPath), changedPath).toBe(false);
    }
    const newModule = "src/plugins/unrelated-new-plugin.ts";
    const newModuleTargets = resolvePolicyTestTargets([newModule]);
    const testOnlyTargets = resolvePolicyTestTargets(["src/plugins/unrelated-new-plugin.test.ts"]);
    for (const [guard] of guards) {
      expect(newModuleTargets).toContain(guard);
      expect(testOnlyTargets).not.toContain(guard);
    }
    expect(isPolicyTestOwnedPath(newModule)).toBe(false);
    expect(isPolicyTestOwnedPath(manifest)).toBe(true);
    const shards = expectDefined(createChangedNodeTestShards([manifest]), "manifest test plan");
    for (const [guard, config] of guards) {
      const owners = shards
        .flatMap((shard) => shard.groups ?? [])
        .filter((group) => group.includePatterns?.includes(guard));
      expect(owners).toHaveLength(1);
      expect(owners[0]?.configs).toEqual([config]);
    }
  });

  it("runs Telegram skill script changes, including test-only edits, through the skill wrapper", () => {
    const wrapper = "test/scripts/telegram-e2e-userbot-skill.test.ts";
    const scriptsDir = ".agents/skills/telegram-e2e-userbot/scripts";
    const scripts = readdirSync(scriptsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => `${scriptsDir}/${entry.name}`);
    expect(scripts.filter((file) => /\.test\.(?:mjs|py)$/u.test(file)).length).toBeGreaterThan(0);
    for (const changedPath of scripts) {
      expect(resolvePolicyTestTargets([changedPath]), changedPath).toContain(wrapper);
    }
    const changedTest = `${scriptsDir}/telegram-run-composition.test.mjs`;
    const shards = expectDefined(
      createChangedNodeTestShards([changedTest], { selectionMode: "aggressive" }),
      "skill test plan",
    );
    const groups = shards.flatMap((shard) => shard.groups ?? []);
    const selected = [
      ...shards.flatMap((shard) => shard.targets ?? []),
      ...groups.flatMap((group) => group.includePatterns ?? []),
    ];
    expect(selected).not.toContain(changedTest);
    const owners = groups.filter((group) => group.includePatterns?.includes(wrapper));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
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

  it("keeps reduced Gateway coverage under distinct complete timing parts", () => {
    const isReleaseOnlyRuntime = proofTestInventory.isReleaseOnlyRuntimeTestFile;
    vi.spyOn(proofTestInventory, "isReleaseOnlyRuntimeTestFile").mockImplementation(
      (file) => file === "src/gateway/server.chat-cli-auth.test.ts" || isReleaseOnlyRuntime(file),
    );
    const options = {
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: false,
    };
    const owner = expectDefined(
      createNodeTestShards(options).find(
        (shard) => shard.shardName === "agentic-gateway-server-isolated",
      ),
      "reduced Gateway owner",
    );
    const stripes = createNodeTestShardBundles(options).filter((shard) =>
      shard.shardName.startsWith("agentic-gateway-server-isolated-"),
    );
    expect(stripes.length).toBeGreaterThan(1);
    const timingKeys = stripes.map((stripe) =>
      expectDefined(stripe.timing_key, "reduced Gateway stripe timing"),
    );
    expect(new Set(timingKeys).size).toBe(stripes.length);
    expect(timingKeys).not.toContain(owner.timing_key);
    expect(stripes.flatMap((stripe) => stripe.includePatterns ?? []).toSorted()).toEqual(
      owner.includePatterns?.toSorted(),
    );
    const timingParts = timingKeys.map((key) =>
      expectDefined(parseCompactSplitTimingKey(key), "reduced Gateway timing part"),
    );
    expect(timingParts.map((part) => part.parentShardName)).toEqual(
      stripes.map(() => "changed-agentic-gateway-server-isolated"),
    );
    expect(new Set(timingParts.map((part) => part.generationKey)).size).toBe(1);
    expect(timingParts.map((part) => part.expectedParts)).toEqual(
      stripes.map(() => stripes.length),
    );
    expect(timingParts.map((part) => part.part).toSorted((a, b) => a - b)).toEqual(
      stripes.map((_, index) => index + 1),
    );
  });

  it.each([
    { profile: "github", legacy: 186, measured: 370, defaultSeconds: 40, preparation: 96 },
    { profile: "hybrid", legacy: 101, measured: 310, defaultSeconds: 22, preparation: 60 },
  ])(
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
      expect(seconds(before)).toBe(640);
      expect(seconds(after) - seconds(before)).toBe(80);
    } finally {
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.resetModules();
    }
  });

  it.each([
    { profile: "github", timingProfile: "github", addedSeconds: 40 },
    { profile: "hybrid", timingProfile: "blacksmith", addedSeconds: 40 },
  ] as const)(
    "uses exact $profile child timings across sibling generations without changing partitions",
    ({ profile, timingProfile, addedSeconds }) => {
      const restore = selectFixtureProjects(
        (config) => config === agentVitestProjectOwners.support.config,
      );
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
        // Exact child observations supersede a stale parent projection in either direction.
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

        expect(totalSeconds(belowFloor)).toBeLessThan(totalSeconds(unmeasured));
        expect(totalSeconds(baseline) - totalSeconds(belowFloor)).toBe(199);
        expect(totalSeconds(updated) - totalSeconds(baseline)).toBe(addedSeconds);
        expect(testPartition(baseline)).toEqual(testPartition(unmeasured));
        expect(testPartition(updated)).toEqual(testPartition(baseline));
        expect(
          updated.flatMap((shard) => shard.groups).find((group) => group.shard_name === shardName)
            ?.timing_key,
        ).toBe(timingKey);

        const previousGeneration = timingKey.replace(
          /#generation-[^#]+/u,
          "#generation-000000000000",
        );
        directTimings = { [previousGeneration]: 240 };
        const reused = createNodeTestShardBundles(options);
        expect(totalSeconds(reused)).toBe(totalSeconds(updated));
        expect(testPartition(reused)).toEqual(testPartition(updated));
        for (const incompatible of [
          previousGeneration.replace(
            /(#include-\d+-)[a-f0-9]+$/u,
            (_match, prefix) => `${prefix}000000000000`,
          ),
          previousGeneration.replace(
            /(#selector-\d+-)[a-f0-9]+/u,
            (_match, prefix) => `${prefix}000000000000`,
          ),
        ]) {
          directTimings = { [incompatible]: 1_000 };
          expect(totalSeconds(createNodeTestShardBundles(options))).toBe(totalSeconds(unmeasured));
        }
      } finally {
        restore();
      }
    },
  );

  it.each([
    { companion: false, nativeSample: false },
    { companion: true, nativeSample: true },
  ])(
    "prices storage work without changing placement (companion: $companion, native sample: $nativeSample)",
    async ({ companion, nativeSample }) => {
      const config = "test/vitest/vitest.infra.config.ts";
      const longest = MEASURED_STORAGE_RECOVERY_TEST;
      const ordinary = "src/infra/sqlite-readonly-location.copy.test.ts";
      vi.resetModules();
      vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
        fullSuiteVitestShards: [{ name: "core-runtime", config, projects: [config] }],
      }));
      vi.doMock("../vitest/vitest.database-worker-core-paths.mjs", async (importOriginal) => ({
        ...(await importOriginal<
          typeof import("../vitest/vitest.database-worker-core-paths.mjs")
        >()),
        databaseWorkerCoreTestFiles: [longest],
      }));
      vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
        listTrackedTestFiles: (root: string) =>
          companion && root === "src/infra" ? [ordinary] : [],
      }));
      const measurements: Record<string, number> = { "core-runtime-infra-storage-state": 1 };
      vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
        ...testTimings,
        readCompactGroupTimings: () => measurements,
        readRuntimePlacementTimings: () => [],
      }));
      vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
        ...(await importOriginal<
          typeof import("../../scripts/lib/vitest-build-prerequisites.mts")
        >()),
        resolveVitestPretestBuildMode: () => undefined,
      }));
      try {
        const {
          createNodeTestShardBundles: createPlan,
          createSelectedNodeTestShardBundles: createSelectedPlan,
        } = await import("../../scripts/lib/ci-node-test-plan.mts");
        const plan = createPlan({ compactMode: "push", runnerBackend: "blacksmith" });
        expect(
          plan.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!)).toSorted(),
        ).toEqual((companion ? [longest, ordinary] : [longest]).toSorted());
        const longestJob = expectDefined(
          plan.find((job) => job.groups.some((group) => group.includePatterns?.includes(longest))),
          "measured storage file row",
        );
        // The measured file span is indivisible; its wrapper is paid once even at more workers.
        expect(longestJob.predictedTestSeconds).toBeGreaterThanOrEqual(279.963 + 20);
        expect(longestJob.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
        expect(plan.every((job) => job.predictedTestSeconds! <= 300)).toBe(true);
        if (nativeSample) {
          const targets = [longest, ordinary];
          const selectedBefore = createSelectedPlan(targets, { runnerBackend: "blacksmith" });
          const hostedBefore = createPlan({ compactMode: "push", runnerBackend: "github" });
          const key = expectDefined(
            createNativeSoloTimingKey(longestJob.groups[0]!),
            "native solo key",
          );
          measurements[key] = 123;
          for (const [before, after] of [
            [plan, createPlan({ compactMode: "push", runnerBackend: "blacksmith" })],
            [selectedBefore, createSelectedPlan(targets, { runnerBackend: "blacksmith" })],
          ]) {
            expect(before).not.toBeNull();
            expect(after).not.toBeNull();
            const expected = structuredClone(before!);
            for (const job of expected) {
              if (job.groups.some((group) => group.includePatterns?.includes(longest))) {
                job.predictedSeconds = 123;
                job.predictedTestSeconds = 123;
              }
            }
            expect(after).toEqual(expected);
          }
          // A native price cannot reprice hosted execution of the same file.
          expect(createPlan({ compactMode: "push", runnerBackend: "github" })).toEqual(
            hostedBefore,
          );
        }
      } finally {
        vi.doUnmock("../../scripts/lib/vitest-build-prerequisites.mts");
        vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
        vi.doUnmock("../../scripts/lib/list-test-files.mts");
        vi.doUnmock("../vitest/vitest.database-worker-core-paths.mjs");
        vi.doUnmock("../vitest/vitest.test-shards.mjs");
        vi.resetModules();
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

  it("partitions whole-config runtime consumers from ordinary serial CLI work", () => {
    const config = "test/vitest/vitest.cli-process.config.ts";
    const restore = selectFixtureProjects((candidate) => candidate === config);
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
      // Runtime preparation is charged once, outside the predicted test step.
      expect(expensive[0]).toMatchObject({
        predictedSeconds: 160,
        predictedTestSeconds: 100,
        planConcurrency: 1,
      });
      expect(expensive[0]!.groups).toHaveLength(1);
      expect(expensive[0]!.groups[0]!.includePatterns?.toSorted()).toEqual(runtimeFiles);
    } finally {
      restore();
    }
  });

  it("shares the serial CLI budget between complete regular CLI children", () => {
    const config = "test/vitest/vitest.cli.config.ts";
    const files = ["src/cli/budget-a.test.ts", "src/cli/budget-b.test.ts"];
    const restore = selectFixtureProjects((candidate) => candidate === config);
    const listFiles = nodeTestInventory.listWholeConfigSplitFiles;
    vi.spyOn(nodeTestInventory, "listWholeConfigSplitFiles").mockImplementation((name) =>
      name === "agentic-cli" ? files : listFiles(name),
    );
    vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockReturnValue(120);
    const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({
      "agentic-cli": 240,
    });
    const options = {
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request" as const,
      runnerBackend: "hybrid",
    };
    try {
      const plan = createNodeTestShardBundles(options);
      expect(plan).toHaveLength(1);
      const [job] = plan;
      expect(job).toMatchObject({
        planConcurrency: 1,
        requiresDist: false,
        predictedSeconds: 240,
        predictedTestSeconds: 240,
      });
      expect(job!.pretestBuildMode).toBeUndefined();
      expect(job!.groups).toHaveLength(2);
      expect(
        job!.groups.map(({ configs, includePatterns, env }) => ({ configs, includePatterns, env })),
      ).toEqual(
        files.map((file) => ({ configs: [config], includePatterns: [file], env: undefined })),
      );
      const keys = job!.groups.map((group) => group.timing_key!);
      for (const costs of [
        [140, 140],
        [160, 60],
      ]) {
        timings.mockReturnValue({
          "agentic-cli": 240,
          ...Object.fromEntries(keys.map((key, index) => [key, costs[index]!])),
        });
        const separate = createNodeTestShardBundles(options);
        expect(separate).toHaveLength(2);
        expect(separate.every((row) => row.planConcurrency === 1 && row.groups.length === 1)).toBe(
          true,
        );
        expect(separate.flatMap((row) => row.groups)).toEqual(job!.groups);
      }
    } finally {
      restore();
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

  it("keeps precise tooling selection through hosted overflow refusal", () => {
    const tooling = defaultShards.filter((shard) => /^core-tooling-\d+$/u.test(shard.shardName));
    // Full-suite rows include release proofs; precise PR plans always exclude them.
    const selected = tooling
      .flatMap((shard) => shard.includePatterns ?? [])
      .filter((file) => !isCiProofTestFile(file))
      .slice(0, 102);
    expect(selected).toHaveLength(102);
    vi.spyOn(testTimings, "readToolingFileTimings").mockReturnValue({});
    vi.spyOn(shardMetadata, "estimateVitestToolingFileSeconds").mockReturnValue(20_000);
    // Every selected file is now indivisible above the admission cap. Overflow
    // must retain these 102 files without adding unrelated dist owners or the full suite.
    expect(() => createSelectedNodeTestShardBundles(selected, { runnerBackend: "github" })).toThrow(
      "exceeds 96 jobs (102 planned)",
    );
  });

  it.each(
    ["github", "hybrid"].flatMap((runnerBackend) =>
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
      expect(groups[0]!.configs).toEqual([
        owner === "agentic-cli"
          ? "test/vitest/vitest.cli.config.ts"
          : "test/vitest/vitest.gateway-client.config.ts",
      ]);
      if (owner === "agentic-cli") {
        expect(groups[0]!.shard_name).toMatch(/^agentic-cli(?:-hosted-\d+)?$/u);
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
      if (owner === "agentic-gateway-core-2") {
        const changed = expectDefined(
          createChangedNodeTestShards([target], { runnerBackend }),
          "changed Gateway client plan",
        );
        expect(changed.flatMap((job) => job.targets ?? [])).not.toContain(target);
        const changedOwner = expectDefined(
          changed.find((job) =>
            job.groups?.some((group) => group.includePatterns?.includes(target)),
          ),
          "changed Gateway client process owner",
        );
        expect(changedOwner.groups).toEqual(groups);
        expect(changedOwner.planConcurrency).toBe(1);
      }
    },
  );

  it.each(["github"])(
    "shares one prepared runtime across affordable %s groups",
    (runnerBackend) => {
      const targets = [
        PRIVATE_QA_TOOLING_TEST,
        "src/infra/update-candidate-canary.integration.test.ts",
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

  it("retains the ordered wall budget when repacking selected files", async () => {
    const config = "test/vitest/vitest.infra.config.ts";
    const entries = [
      ["src/infra/env.test.ts", "core-runtime-infra-env-auth", 170],
      ["src/infra/os-summary.test.ts", "core-runtime-infra-misc-os", 170],
      ["src/infra/ports-probe.test.ts", "core-runtime-infra-system-runtime", 160],
      ["src/infra/provider-usage.test.ts", "core-runtime-infra-provider-push", 160],
      ["src/infra/channel-runtime-context.test.ts", "core-runtime-infra-channel-plugin", 150],
      ["src/infra/diagnostic-trace-context.test.ts", "core-runtime-infra-diagnostics-state", 150],
    ] as const;
    const files = entries.map(([file]) => file);
    const targets = files.slice(0, 3);
    vi.resetModules();
    vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
      fullSuiteVitestShards: [{ name: "core-runtime", config, projects: [config] }],
    }));
    vi.doMock("../vitest/vitest.database-worker-core-paths.mjs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../vitest/vitest.database-worker-core-paths.mjs")>()),
      databaseWorkerCoreTestFiles: [],
      isDatabaseWorkerCoreTestFile: () => false,
    }));
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (root: string) => (root === "src/infra" ? files : []),
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", () => ({
      ...testTimings,
      readCompactGroupTimings: () =>
        Object.fromEntries(entries.map(([, owner, seconds]) => [owner, seconds])),
      readRuntimePlacementTimings: () => [],
    }));
    vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../../scripts/lib/vitest-build-prerequisites.mts")
      >()),
      resolveVitestPretestBuildMode: () => undefined,
    }));
    try {
      const { createSelectedNodeTestShardBundles: createSelected } =
        await import("../../scripts/lib/ci-node-test-plan.mts");
      const selected = expectDefined(
        createSelected(targets, { runnerBackend: "blacksmith" }),
        "selected infra plan",
      );
      // The selected 170/170/160 envelopes fit the aggregate limit but need 330 seconds together.
      expect(selected).toHaveLength(2);
      expect(selected.every((job) => job.planConcurrency === 2)).toBe(true);
      expect(selected.every((job) => job.predictedTestSeconds! <= 300)).toBe(true);
      expect(selected.map((job) => job.predictedTestSeconds!).toSorted((a, b) => a - b)).toEqual([
        160, 170,
      ]);
      expect(selected.reduce((sum, job) => sum + job.predictedSeconds!, 0)).toBe(500);
      expect(
        selected.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!)).toSorted(),
      ).toEqual(targets.toSorted());
    } finally {
      vi.doUnmock("../../scripts/lib/vitest-build-prerequisites.mts");
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
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

  it.each(["pull-request"] as const)(
    "exchanges hosted anchors before opening another %s job",
    async (compactMode) => {
      const anchors = [126, 105, 63, 42, 42, 42].map((seconds, index) => ({
        name: `exchange-anchor-${index}`,
        seconds,
      }));
      const shards = anchors.map(({ name }) => ({
        config: `test/vitest/vitest.${name}.config.ts`,
        name,
        projects: [`test/vitest/vitest.${name}.config.ts`],
      }));
      const plan = await createToolingFixturePlan({
        files: [],
        shards,
        timings: Object.fromEntries(anchors.map(({ name, seconds }) => [name, seconds])),
        fileSeconds: () => 0,
        options: {
          compactMode,
          runnerBackend: "github",
          includeReleaseOnlyPluginShards: false,
          compactNodeJobCap: 2,
        },
      });
      expect(plan).toHaveLength(2);
      expect(
        plan
          .flatMap((job) => job.groups)
          .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name)),
      ).toEqual(
        shards.map(({ name, projects }) => ({
          shard_name: name,
          configs: projects,
          requiresDist: false,
          runner: BUNDLED_NODE_TEST_RUNNER,
        })),
      );
      for (const job of plan) {
        expect(job.predictedSeconds).toBe(210);
        expect(job.planConcurrency).toBe(1);
        expect(job.groups.length).toBeLessThanOrEqual(10);
      }
    },
  );

  it.each([
    { profile: "blacksmith", expectedSeconds: 840, whaleSeconds: 200 },
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
      // Setup is separate from the sum of the test-step packing prices.
      expect(plan.reduce((seconds, job) => seconds + job.predictedSeconds!, 0)).toBe(
        expectedSeconds,
      );
      expect(
        plan.find((job) => job.groups.some((group) => group.includePatterns?.includes(whale)))
          ?.predictedSeconds,
      ).toBeGreaterThanOrEqual(whaleSeconds);
      const whaleOnly = await createToolingFixturePlan({ ...params, files: [whale] });
      expect(
        whaleOnly
          .filter((job) => job.groups.some((group) => group.includePatterns?.includes(whale)))
          .map((job) => job.predictedSeconds),
      ).toEqual([whaleSeconds]);
      expect(whaleOnly.reduce((seconds, job) => seconds + job.predictedSeconds!, 0)).toBe(
        whaleSeconds,
      );
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
        "src/gateway/talk/client-spoken-confirmation.test.ts",
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

  it.each(
    (["hybrid"] as const).flatMap((runnerBackend) =>
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
      ]);
      expect(owner.group.pretestBuildMode).toBe(buildMode);
      expect(owner.shard.planConcurrency).toBe(1);
      if (buildMode) {
        expect(owner.shard.pretestBuildMode).toBe(buildMode);
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

  it.each([
    RELEASE_REPORT_OWNER_TEST,
    "scripts/lib/vitest-report-owner.mts",
    "src/scripts/example.ts",
    "config/ci-budget.md",
    "test/vitest/vitest.tooling.config.ts",
    "package.json",
    "patches/vitest@5.0.1.patch",
    ".github/workflows/ci.yml",
    "apps/ios/fastlane/Fastfile",
    "extensions/matrix/scripts/build.mjs",
  ])("retains the complete tooling family when owner %s changes", (changedPath) => {
    expect(
      createNodeTestShards({
        includeReleaseOnlyToolingShards: false,
        changedPaths: ["src/plugin-sdk/core.ts", changedPath],
      }),
    ).toEqual(defaultShards);
  });

  it.each(["github"])(
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

  it("keeps changed native browser tests in UI jobs", () => {
    const target = "extensions/workboard/browser/catalog.test.ts";
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.targets ?? shard.includePatterns ?? [])).toContain(
      target,
    );
  });

  it.each(["extensions/telegram/src/bot.create-telegram-bot.native-pipeline.test.ts"])(
    "prepares the provider runtime for selected extension target %s",
    (target) => {
      const owners = (createChangedNodeTestShards([target]) ?? []).filter((shard) =>
        (shard.groups ?? [shard]).some((group) => group.includePatterns?.includes(target)),
      );

      expect(owners).toHaveLength(1);
      expect(owners[0]?.pretestBuildMode).toBe("runtime");
    },
  );

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

  it("retains only exact changed plugin-owner tests in deterministic order", () => {
    const options = {
      includeReleaseOnlyPluginShards: false,
      changedPaths: [
        ...STORE_ALIAS_CHANGED_PATHS.toReversed(),
        " src/plugins/tools.optional.test.ts",
        String.raw`src\plugins\tools.optional.test.ts`,
        "src/plugins/tools.optional.test.ts",
        PLUGIN_PRERELEASE_NPM_SPEC_TEST,
        "src/plugins/runtime.test.ts",
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        "src/plugins/loader.test.ts",
        "src/plugins/install.npm-spec.e2e.test.ts",
      ],
    };
    const shards = createNodeTestShards(options);
    expect(shards.find((shard) => shard.shardName === "agentic-plugins")?.includePatterns).toEqual([
      "src/plugins/runtime.test.ts",
      "src/plugins/tools.optional.test.ts",
    ]);
    expect(
      shards.flatMap(
        (shard) =>
          shard.includePatterns
            ?.filter((file) => file === PLUGIN_PRERELEASE_NPM_SPEC_TEST)
            .map(() => shard.configs) ?? [],
      ),
    ).toEqual([["test/vitest/vitest.infra.config.ts"]]);
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
  it.each([
    {
      owner: "infra",
      prefix: "core-runtime-infra-",
      config: "test/vitest/vitest.infra.config.ts",
      expectedFiles: () => [
        ...new Set([...listTestFiles("src/infra"), ...databaseWorkerCoreTestFiles]),
      ],
    },
    {
      owner: "cron",
      prefix: "core-runtime-cron-",
      config: undefined,
      expectedFiles: () => listTestFiles("src/cron"),
    },
  ])(
    "covers every $owner test exactly once across split shards",
    ({ prefix, config, expectedFiles }) => {
      const actual = defaultShards
        .filter((shard) => shard.shardName.startsWith(prefix))
        .filter((shard) => !config || shard.configs.includes(config))
        .flatMap((shard) => shard.includePatterns ?? [])
        .toSorted((a, b) => a.localeCompare(b));

      expect(actual).toEqual(expectedFiles().toSorted((a, b) => a.localeCompare(b)));
      expect(new Set(actual).size).toBe(actual.length);
    },
  );

  it("covers every auto-reply reply test exactly once across split shards", () => {
    const actual = defaultShards
      .filter((shard) => shard.shardName.startsWith("auto-reply-reply-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listTestFiles("src/auto-reply/reply"));
    expect(new Set(actual).size).toBe(actual.length);
  });
});
