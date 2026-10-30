import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createChangedNodeTestShards as changedTests,
  createNodeWorkerE2eTestShards,
  hasControlUiPerformanceAffectingChange,
  hasPromptSnapshotAffectingChange,
  hasSqliteSessionLifecycleAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { rebalanceMeasuredSerialJobs } from "../../scripts/lib/ci-measured-compact-packing.mts";
import * as nodeTestInventory from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  type CompactNodeTestShard,
  createNodeTestShardBundles as bundleTests,
  createNodeTestShards as planTests,
  createSelectedNodeTestShardBundles as selectTests,
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
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../vitest/vitest.agents-paths.mjs";
import { createAgentsSupportVitestConfig } from "../vitest/vitest.agents-support.config.ts";
import { createAutoReplyReplyVitestConfig } from "../vitest/vitest.auto-reply-reply.config.ts";
import { cliProcessTestFiles } from "../vitest/vitest.cli-process-paths.mjs";
import { createCliProcessVitestConfig } from "../vitest/vitest.cli-process.config.ts";
import { databaseWorkerCoreTestFiles } from "../vitest/vitest.database-worker-core-paths.mjs";
import { createGatewayCoreVitestConfig } from "../vitest/vitest.gateway-core.config.ts";
import { createGatewayDatabaseWorkersVitestConfig } from "../vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "../vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "../vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "../vitest/vitest.gateway-server-isolated.config.ts";
import { gatewayServerSerialTestFiles } from "../vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "../vitest/vitest.gateway-server.config.ts";
import { createInfraVitestConfig } from "../vitest/vitest.infra.config.ts";
import { createRuntimeConfigVitestConfig } from "../vitest/vitest.runtime-config.config.ts";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import * as uiPaths from "../vitest/vitest.ui-paths.mjs";
import * as unitFastPaths from "../vitest/vitest.unit-fast-paths.mjs";
import {
  createChangedNodeTestShards as changedOwnerTests,
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
const { uiE2eRealGatewayTestFiles } = uiPaths;
const { getUnitFastIsolatedTestFiles, getUnitFastTimerTestFiles } = unitFastPaths;

function required<T>(value: T | null | undefined) {
  return expectDefined(value, "required test fixture");
}

type TestGroup = CompactNodeTestShard["groups"][number];
const jobGroups = (job: Pick<CompactNodeTestShard, "groups">) => job.groups;
const requiredPatterns = (group: Pick<TestGroup, "includePatterns">) => group.includePatterns!;
const optionalPatterns = (group: Pick<TestGroup, "includePatterns">) => group.includePatterns ?? [];
const workers = (group: Pick<TestGroup, "env"> | undefined) =>
  group?.env?.OPENCLAW_VITEST_MAX_WORKERS;
const groupName = (group: Pick<TestGroup, "shard_name">) => group.shard_name;
const sumSeconds = (jobs: readonly CompactNodeTestShard[]) =>
  jobs.reduce((sum, job) => sum + job.predictedSeconds!, 0);
const sumOptionalSeconds = (jobs: readonly CompactNodeTestShard[]) =>
  jobs.reduce((sum, job) => sum + (job.predictedSeconds ?? 0), 0);
const configPath = (name: string) => `test/vitest/vitest.${name}.config.ts`;
const lintSuppressionInventoryTest = "test/scripts/lint-suppressions.test.ts";
function planFiles(jobs: readonly CompactNodeTestShard[], patterns = optionalPatterns) {
  return jobs.flatMap(jobGroups).flatMap(patterns);
}
const sumRequiredSeconds = (jobs: readonly CompactNodeTestShard[]) =>
  jobs.reduce((sum, job) => sum + required(job.predictedSeconds), 0);

function splitGeneration(
  configs: Parameters<typeof createCompactSplitTimingGeneration>[0]["configs"],
  parentShardName: string,
  stripes: readonly (readonly string[])[],
  env?: Readonly<Record<string, string>>,
) {
  return createCompactSplitTimingGeneration({ configs, parentShardName, stripes, env });
}
function mockOriginal<K extends FixtureOwner>(owner: K, overrides: Partial<FixtureModules[K]>) {
  mockFixture(owner, async (original) => ({ ...(await original()), ...overrides }));
}

function spyTimings() {
  return vi.spyOn(testTimings, "readCompactGroupTimings");
}
function only<T>(items: readonly T[]) {
  expect(items).toHaveLength(1);
  return required(items[0]);
}

function fixtureShard(name: string, projects: string[], config = projects[0]!) {
  return { name, config, projects };
}
function mockProject(
  name: string,
  config: string,
  root: string,
  files: string[],
  timings: Readonly<Record<string, number>>,
) {
  vi.resetModules();
  mockPlanShards(() => [fixtureShard(name, [config])]);
  mockTrackedFiles((candidate) => (candidate === root ? files : []));
  mockPlanTimings(() => timings);
}
function setTimingParts(timings: Record<string, number>, keys: readonly string[], seconds: number) {
  Object.assign(timings, Object.fromEntries(keys.map((key) => [key, seconds])));
}
function expectPlanFiles(
  jobs: readonly CompactNodeTestShard[],
  expected: readonly string[],
  patterns = optionalPatterns,
) {
  expectSameEntries(planFiles(jobs, patterns), expected);
}
function sortedGroups(jobs: readonly CompactNodeTestShard[]) {
  return jobs.flatMap(jobGroups).toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
}
function compactOptions(runnerBackend: string, compactMode: "push" | "pull-request") {
  return { runnerBackend, compactMode, includeReleaseOnlyPluginShards: false as const };
}
function findFileJob<T extends { groups?: readonly Pick<TestGroup, "includePatterns">[] }>(
  jobs: readonly T[],
  file: string,
) {
  return jobs.find((job) => job.groups?.some((group) => group.includePatterns?.includes(file)));
}
function findGroupJob(jobs: readonly CompactNodeTestShard[], name: string) {
  return jobs.find((job) => job.groups.some((group) => group.shard_name === name));
}
// Exact field equality keeps missing optional fields and nested executor policies significant.
function expectFields<T extends object>(actual: T | undefined, expected: Partial<T>) {
  const fields = required(actual);
  for (const key in expected) {
    expect(fields[key], key).toEqual(expected[key]);
  }
}
function expectInherited<T extends object>(
  actual: T | undefined,
  owner: T | undefined,
  ...keys: (keyof T)[]
) {
  for (const key of keys) {
    expect(required(actual)[key], String(key)).toEqual(owner?.[key]);
  }
}
function expectEvery<T>(items: readonly T[], predicate: (item: T) => unknown, message?: string) {
  expect(items.every(predicate), message).toBe(true);
}
function expectNone<T>(items: readonly T[], predicate: (item: T) => unknown, message?: string) {
  expect(items.some(predicate), message).toBe(false);
}
function expectSameEntries(actual: readonly string[], expected: readonly string[]) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  expect(actual.toSorted(compare)).toEqual(expected.toSorted(compare));
}

const fixtureModuleIds = {
  shards: "../vitest/vitest.test-shards.mjs",
  files: "../../scripts/lib/list-test-files.mts",
  timings: "../../scripts/lib/ci-test-timings.mts",
  metadata: "../../scripts/lib/vitest-shard-metadata.mts",
  build: "../../scripts/lib/vitest-build-prerequisites.mts",
  fast: "../vitest/vitest.unit-fast-paths.mjs",
  database: "../vitest/vitest.database-worker-core-paths.mjs",
  inventory: "../../scripts/lib/ci-node-test-inventory.mts",
  ui: "../vitest/vitest.ui-paths.mjs",
} as const;
type FixtureModules = {
  shards: typeof import("../vitest/vitest.test-shards.mjs");
  files: typeof import("../../scripts/lib/list-test-files.mts");
  timings: typeof testTimings;
  metadata: typeof shardMetadata;
  build: typeof buildPrerequisites;
  fast: typeof import("../vitest/vitest.unit-fast-paths.mjs");
  database: typeof import("../vitest/vitest.database-worker-core-paths.mjs");
  inventory: typeof nodeTestInventory;
  ui: typeof uiPaths;
};
type FixtureOwner = keyof FixtureModules;
function mockFixture<K extends FixtureOwner>(
  owner: K,
  factory: (
    original: () => Promise<FixtureModules[K]>,
  ) => FixtureModules[K] | Promise<FixtureModules[K]>,
) {
  vi.doMock(fixtureModuleIds[owner], (importOriginal) =>
    factory(() => importOriginal<FixtureModules[K]>()),
  );
}

function resetPlanMocks(extraMocks: readonly FixtureOwner[]) {
  for (const owner of [...extraMocks, "timings", "files", "shards", "ui", "fast"] as const) {
    vi.doUnmock(fixtureModuleIds[owner]);
  }
  vi.resetModules();
}
async function loadPlanModule(extraMocks: readonly FixtureOwner[] = []) {
  onTestFinished(() => resetPlanMocks(extraMocks));
  return import("../../scripts/lib/ci-node-test-plan.mts");
}
async function withPlanModule<T>(
  run: (planner: typeof import("../../scripts/lib/ci-node-test-plan.mts")) => T,
  extraMocks: readonly FixtureOwner[] = [],
): Promise<T> {
  try {
    return run(await import("../../scripts/lib/ci-node-test-plan.mts"));
  } finally {
    resetPlanMocks(extraMocks);
  }
}

function mockPlanShards(shards: () => typeof fullSuiteVitestShards) {
  // Synthetic packing fixtures reuse actual inventories instead of rediscovering unrelated files.
  mockFixture("ui", () => uiPaths);
  mockFixture("fast", () => unitFastPaths);
  mockFixture("shards", async (original) => ({
    ...(await original()),
    fullSuiteVitestShards: shards(),
  }));
}
function mockTrackedFiles(list: (root: string) => string[]) {
  mockOriginal("files", { listTrackedTestFiles: list });
}
function mockPlanTimings(read: () => Readonly<Record<string, number>>) {
  mockFixture("timings", () => ({
    ...testTimings,
    readCompactGroupTimings: read,
    readRuntimePlacementTimings: () => [],
  }));
}
function mockUnbuiltRuntime() {
  mockOriginal("build", { resolveVitestPretestBuildMode: () => undefined });
}
async function mockFastPaths(files: string[] = []) {
  const original = await vi.importActual<FixtureModules["fast"]>(fixtureModuleIds.fast);
  vi.resetModules();
  mockFixture("fast", () => ({
    ...original,
    getUnitFastTestFiles: () => [...files],
    getUnitFastIsolatedTestFiles: () => [],
    getUnitFastTimerTestFiles: () => [],
    getUnitFastTestFilesForIncludePatterns: () => [...files],
  }));
}

describe("Control UI release-only inventories", () => {
  const sidebar = "ui/src/components/app-sidebar.stress.browser.test.ts";
  const embed = "ui/src/e2e/native-embed-settings.e2e.test.ts";
  const entry = "ui/src/e2e/chat-session-entry.e2e.test.ts";
  const staleBuild = "ui/src/e2e/control-ui-stale-build-reload.e2e.test.ts";
  const teamScale = "ui/src/e2e/team-scale-cold-load.e2e.test.ts";
  const automationManagement =
    "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts";
  const reconnectContinuity = "ui/src/e2e/chat-reconnect-continuity.real-gateway.e2e.test.ts";
  const releaseOnlyRealGateway = new Set([
    "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
    "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
    "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
    automationManagement,
    "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
    "ui/src/e2e/session-pr-reader-lifetime.real-gateway.e2e.test.ts",
    "ui/src/e2e/chat-collaborator-scroll.real-gateway.e2e.test.ts",
    reconnectContinuity,
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
      shards.map(({ shard, shard_count, run_desktop }) => ({ shard, shard_count, run_desktop })),
    ).toEqual([
      { shard: 1, shard_count: 2, run_desktop: expectedFiles.includes(desktop) },
      { shard: 2, shard_count: 2, run_desktop: false },
    ]);
    const files = shards.flatMap((shard) =>
      shard.groups
        .flatMap((group) => {
          expect(group.configs).toEqual([configPath("ui-e2e-prebuilt")]);
          expect(group.includePatterns.length).toBeGreaterThan(0);
          expect(group.includePatterns).not.toContain(desktop);
          return group.includePatterns;
        })
        .concat(shard.run_desktop ? [desktop] : []),
    );
    // Array equality also catches duplicate ownership between jobs or desktop proof.
    expectSameEntries(files, expectedFiles);
  }

  it("balances serial and qualified real-Gateway work around desktop proof", () => {
    const desktop = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";
    const serial = [
      "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
      "ui/src/e2e/chat-daybreak.real-gateway.e2e.test.ts",
      "ui/src/e2e/quiet-automations.real-gateway.e2e.test.ts",
      "ui/src/e2e/plugin-inline-view.real-gateway.e2e.test.ts",
    ];
    const parallel = [
      "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
      "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
    ];
    const fileSeconds: Record<string, number> = {
      [desktop]: 80,
      [serial[0]!]: 60,
      [serial[1]!]: 50,
      [serial[2]!]: 40,
      [serial[3]!]: 10,
    };
    for (const file of parallel) {
      fileSeconds[file] = 100;
    }
    const timings = vi.spyOn(testTimings, "readUiE2eFileTimings").mockReturnValue({
      fileSeconds,
      perFileOverheadSeconds: 0,
    });
    onTestFinished(() => timings.mockRestore());
    const selected = [desktop, ...serial, ...parallel];
    const shards = createUiRealGatewayTestShards([
      { configs: [configPath("ui-e2e")], shard_name: "ui", includePatterns: selected },
    ]);
    expectSameEntries(
      shards.flatMap((shard) => [
        ...(shard.run_desktop ? [desktop] : []),
        ...shard.groups.flatMap((group) => group.includePatterns),
      ]),
      selected,
    );
    const first = shards[0]!;
    expect(first.run_desktop).toBe(true);
    const work = shards.map((shard) => {
      const files = shard.groups[0]!.includePatterns;
      const serialSeconds = files
        .filter((file) => serial.includes(file))
        .reduce((sum, file) => sum + fileSeconds[file]!, 0);
      // Whole 100s files occupy two workers; an odd final file still costs 100s.
      const parallelWaves = Math.ceil(files.filter((file) => parallel.includes(file)).length / 2);
      return Math.max(shard.run_desktop ? 80 : 0, serialSeconds) + parallelWaves * 100;
    });
    expect(Math.max(...work)).toBeLessThanOrEqual(190);
  });

  it.each([
    { name: "disabled proofs", env: {}, activeIndex: -1 },
    { name: "empty steering variant", env: { OPENCLAW_STEER_CUSTODY_PROOF: "" }, activeIndex: -1 },
    { name: "enabled steering", env: { OPENCLAW_STEER_CUSTODY_PROOF: "fixed" }, activeIndex: 1 },
    {
      name: "invalid nonempty steering variant",
      env: { OPENCLAW_STEER_CUSTODY_PROOF: "invalid" },
      activeIndex: 1,
    },
    { name: "disabled DeepSeek flag", env: { OPENCLAW_DEEPSEEK_UI_LIVE: "0" }, activeIndex: -1 },
    {
      name: "enabled DeepSeek without preflight credentials",
      env: { OPENCLAW_DEEPSEEK_UI_LIVE: "1" },
      activeIndex: 0,
    },
  ])("prices $name without removing selected opt-in files", ({ env, activeIndex }) => {
    const optInFiles = [
      "ui/src/e2e/deepseek-search.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-steer-deferred-custody.real-gateway.e2e.test.ts",
    ];
    const parallel = [
      "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
      "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
      "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
    ];
    const timings = vi.spyOn(testTimings, "readUiE2eFileTimings").mockReturnValue({
      // Disabled proofs must ignore even a retained timing from an opted-in run.
      fileSeconds: Object.fromEntries([
        ...optInFiles.map((file) => [file, 60]),
        ...parallel.map((file) => [file, 20]),
      ]),
      perFileOverheadSeconds: 1,
    });
    onTestFinished(() => timings.mockRestore());
    const selected = [...optInFiles, ...parallel];
    const shards = createUiRealGatewayTestShards(
      [{ configs: [configPath("ui-e2e")], shard_name: "ui", includePatterns: selected }],
      env,
    );
    expectSameEntries(
      shards.flatMap((shard) => shard.groups.flatMap((group) => group.includePatterns)),
      selected,
    );
    const work = shards.map((shard) => {
      const files = shard.groups[0]!.includePatterns;
      const serialSeconds = optInFiles.reduce(
        (sum, file, index) => sum + (files.includes(file) ? (index === activeIndex ? 61 : 1) : 0),
        0,
      );
      const parallelWaves = Math.ceil(files.filter((file) => parallel.includes(file)).length / 2);
      return serialSeconds + parallelWaves * 21;
    });
    expect(Math.max(...work)).toBeLessThanOrEqual(activeIndex < 0 ? 23 : 61);
    expect(shards.every((shard) => !shard.run_desktop)).toBe(true);
  });

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
      e2e: [{ configs: [configPath("ui-e2e")], shard_name: configPath("ui-e2e") }],
    });
    expectRealGatewayCoverage(groups.e2e, uiE2eRealGatewayTestFiles);
  });
});

describe("startup corpus coverage", () => {
  const files = startupCorpusTestFiles;
  const group = {
    shard_name: "core-runtime-config",
    configs: [configPath("runtime-config")],
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
const MEASURED_STORAGE_WORK_TEST = "src/system-agent/setup-inference-activate.test.ts";
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
        [configPath("cli"), configPath("cli-process")].includes(config),
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

function useFixtureProjects(owns: (config: string) => boolean) {
  onTestFinished(selectFixtureProjects(owns));
}

type PackingEntry = readonly [string, number] | readonly [string, string, number];
function mockPackingEntries(entries: readonly PackingEntry[], timingName = (name: string) => name) {
  const original = fullSuiteVitestShards.slice();
  onTestFinished(() => {
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
  });
  fullSuiteVitestShards.splice(
    0,
    fullSuiteVitestShards.length,
    ...entries.map(([name, config]) =>
      fixtureShard(
        name,
        [configPath(typeof config === "string" ? config : "hooks")],
        `fixture-${name}.config.ts`,
      ),
    ),
  );
  spyTimings().mockReturnValue(
    Object.fromEntries(
      entries.map(([name, configOrSeconds, seconds]) => [
        timingName(name),
        typeof configOrSeconds === "number" ? configOrSeconds : seconds!,
      ]),
    ),
  );
  vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
  vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
}

describe("scripts/lib/ci-node-test-plan.mts", () => {
  it.each([false, true])(
    "keeps the scheduled main inventory within its reserved compact capacity (extra group: %s)",
    (extraGroup) => {
      const original = fullSuiteVitestShards.slice();
      if (extraGroup) {
        // A new isolated group must not exhaust main's capacity on arrival.
        fullSuiteVitestShards.push(
          fixtureShard(
            "synthetic-capacity-growth",
            [configPath("hooks")],
            "fixture-capacity.config.ts",
          ),
        );
      }
      try {
        const workerRows = createNodeWorkerE2eTestShards();
        const compactRows = bundleTests({
          includeProofTests: true,
          includeReleaseOnlyPluginShards: false,
          includeReleaseOnlyToolingShards: true,
          includeReleaseOnlyRuntimeTests: false,
          includePrExemptRuntimeTests: true,
          compactMode: "pull-request",
          compactNodeJobCap: 77 - workerRows.length,
          mainValidation: true,
          runnerBackend: "hybrid",
        });
        const jobs = [...compactRows, ...workerRows];
        expect(jobs.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(77);
        expect(jobs.length).toBeLessThanOrEqual(79);
        expect(
          compactRows
            .flatMap(jobGroups)
            .filter((group) => group.shard_name === "synthetic-capacity-growth"),
        ).toHaveLength(extraGroup ? 1 : 0);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
      }
    },
  );

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
          configs: [configPath("hooks")],
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
    expectPlanFiles(
      after,
      Array.from({ length: 83 }, (_, index) => `src/hooks/capacity-${index}.test.ts`),
      requiredPatterns,
    );
    expect(after.filter((job) => job.groups.length > 1)).toHaveLength(5);
    for (const job of after) {
      expect(job.predictedSeconds).toBeLessThanOrEqual(210);
      expect(job.groups.length).toBeLessThanOrEqual(10);
      for (const group of job.groups) {
        expect(before.flatMap(jobGroups)).toContain(group);
      }
    }
    expect(
      packCompactNodeTestJobsToCapacity(before, { ...capacityOptions, compactJobCap: 83 }),
    ).toBe(before);
  });

  it.each(["runner", "build", "workers", "environment", "time budget", "group budget"] as const)(
    "refuses over-cap bundles that cannot merge within the existing %s policy",
    (policy) => {
      const jobs = smallCapacityJobs(79);
      for (const [index, job] of jobs.entries()) {
        if (policy === "runner") {
          job.runner = `different-runner-${index}`;
        }
        if (policy === "build") {
          job.pretestBuildMode = "runtime";
        }
        if (policy === "workers") {
          job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "4" };
        }
        if (policy === "environment") {
          job.env!.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS = "60000";
        }
        if (policy === "time budget") {
          job.predictedSeconds = 110;
        }
        if (policy === "group budget") {
          job.groups = Array.from({ length: 10 }, (_, group) => ({
            ...job.groups[0]!,
            shard_name: `capacity-${index}-${group}`,
          }));
        }
      }
      expect(() => packCompactNodeTestJobsToCapacity(jobs, capacityOptions)).toThrow(
        "no compatible bundles fit the existing limits",
      );
    },
  );

  it("retries hybrid Gateway-first packing only when the completed plan exceeds its cap", () => {
    const entries = [
      ["ordinary-a", "hooks", 180],
      ["ordinary-b", "hooks", 180],
      ["ordinary-c", "hooks", 160],
      ["gateway-constrained", "gateway-core", 120],
      ["ordinary-d", "hooks", 120],
      ["ordinary-e", "hooks", 30],
    ] as const;
    mockPackingEntries(entries);

    const options = compactOptions("hybrid", "push");
    const originalJobs = bundleTests(options);
    expect(originalJobs).toHaveLength(3);
    expect(findGroupJob(originalJobs, "gateway-constrained")).toMatchObject({
      planConcurrency: 1,
      predictedSeconds: 280,
    });
    const jobs = bundleTests({ ...options, compactNodeJobCap: 2 });
    // Cost-first packing spends 280s on Gateway and strands 510s of ordinary
    // work across two rows; admitting Gateway first leaves one 490s parallel row.
    expect(jobs).toHaveLength(2);
    const gateway = required(findGroupJob(jobs, "gateway-constrained"));
    expect(gateway).toMatchObject({
      planConcurrency: 1,
      predictedSeconds: 300,
      predictedTestSeconds: 300,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    });
    const ordinary = required(jobs.find((job) => job !== gateway));
    expect(ordinary).toMatchObject({
      planConcurrency: 2,
      predictedSeconds: 490,
      predictedTestSeconds: 280,
    });
    expectEvery(jobs, (job) => job.runner === EXTRA_LARGE_NODE_TEST_RUNNER);
    expectSameEntries(
      jobs.flatMap((job) => job.groups.map(groupName)),
      entries.map(([name]) => name),
    );
    expect(() => bundleTests({ ...options, compactNodeJobCap: 1 })).toThrow(
      "compact hybrid node test plan exceeds 1 jobs (2 planned)",
    );
  });

  it("rejects parallel bins whose ordered queue exceeds the test budget", () => {
    const entries = [170, 170, 160, 160, 150, 150].map(
      (seconds, index) => [`ordinary-${index}`, seconds] as const,
    );
    mockPackingEntries(entries);

    const jobs = bundleTests(compactOptions("blacksmith", "push"));
    // The tempting 170 + 170 + 160 bin fits 500 aggregate seconds but takes 330 on two slots.
    expectEvery(jobs, (job) => job.predictedTestSeconds! <= 300);
    expect(jobs.map((job) => job.planConcurrency)).toEqual([2, 2, 2]);
    expect(sumSeconds(jobs)).toBe(960);
    expectSameEntries(
      jobs.flatMap((job) => job.groups.map(groupName)),
      entries.map(([name]) => name),
    );
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
    mockPackingEntries(entries, (name) =>
      name.startsWith("agentic-agents-embedded-base-") ? name + "#file-parallel" : name,
    );

    const jobs = bundleTests(compactOptions("blacksmith", "push"));
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
    expectSameEntries(
      jobs.flatMap((job) => job.groups.map(groupName)),
      entries.map(([name]) => name),
    );
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
    mockPackingEntries(entries);

    const jobs = bundleTests(compactOptions("blacksmith", "push"));
    const gateway = findGroupJob(jobs, "agentic-gateway-server-isolated");
    expect(gateway).toMatchObject({
      checkName: "checks-node-compact-large-2",
      shardName: "compact-large-2",
      runner: EXTRA_LARGE_NODE_TEST_RUNNER,
      planConcurrency: 1,
      predictedSeconds: 270,
      env: undefined,
    });
    expect(gateway?.groups.map(groupName)).toEqual([
      "agentic-agents-core-runtime",
      "agentic-gateway-server-isolated",
    ]);
    expect(gateway?.groups.map((group) => workers(group))).toEqual(["2", "2"]);
    const parallelJobs = jobs.filter((job) => job !== gateway);
    expect(parallelJobs.map((job) => job.planConcurrency)).toEqual([2, 2]);
    for (const job of parallelJobs) {
      expect(job.predictedSeconds).toBeLessThanOrEqual(500);
      expectEvery(job.groups, (group) => [undefined, "2"].includes(workers(group)));
    }
    expectSameEntries(
      jobs.flatMap((job) => job.groups.map(groupName)),
      entries.map(([name]) => name),
    );
    expect(sumSeconds(jobs)).toBe(entries.reduce((sum, entry) => sum + entry[2], 0));
    expect(jobs).toHaveLength(3);
  });

  let defaultShards: ReturnType<typeof planTests>;

  // Only unchanged committed inputs share snapshots; every caller receives its own graph.
  const committedCompactPlans = new Map<string, CompactNodeTestShard[]>();
  function committedPlan(
    compactMode: "push" | "pull-request",
    runnerBackend?: string,
  ): CompactNodeTestShard[] {
    const key = JSON.stringify([compactMode, runnerBackend]);
    let snapshot = committedCompactPlans.get(key);
    if (!snapshot) {
      snapshot = structuredClone(
        bundleTests({
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
    defaultShards = planTests();
  });

  afterAll(() => {
    committedCompactPlans.clear();
  });

  it("retains child policies while routing RunsOn from measured hybrid pull-request plans", () => {
    const compactMode = "pull-request" as const;

    const hybrid = committedPlan(compactMode, "hybrid");
    const runson = committedPlan(compactMode, "runson");
    const routed = runson.filter((job) => job.runner === "runson-c8i-8xlarge");
    const routedJob = only(routed);
    expect(routedJob).toMatchObject({
      planConcurrency: 1,
      requiresDist: false,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    });
    expect(routedJob.pretestBuildMode).toBeUndefined();
    const cronGroups = routedJob.groups;
    expect(cronGroups.map(groupName).toSorted()).toEqual([
      "core-runtime-cron-parallel-core",
      "core-runtime-cron-parallel-isolated-agent",
      "core-runtime-cron-parallel-service",
    ]);
    const cronNames = new Set(cronGroups.map(groupName));
    const previousCronJobs = hybrid.filter((job) =>
      job.groups.some((group) => cronNames.has(group.shard_name)),
    );
    expect(routedJob.timeoutMinutes).toBe(
      Math.min(...previousCronJobs.map((job) => job.timeoutMinutes ?? 60)),
    );

    expect(sortedGroups(runson)).toEqual(sortedGroups(hybrid));
    expect(runson.filter((job) => job.runner !== "runson-c8i-8xlarge")).toEqual(
      hybrid
        .flatMap((job) => {
          const groups = job.groups.filter((group) => !cronNames.has(group.shard_name));
          return groups.length ? [{ ...job, groups }] : [];
        })
        .toSorted((a, b) => a.checkName.localeCompare(b.checkName)),
    );
    expect(runson.length).toBeLessThanOrEqual(90);
    expect(bundleTests(compactOptions("hybrid", compactMode))).toEqual(hybrid);
  });

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

  it("packs within 300 test seconds while retaining indivisible native-wall outliers", () => {
    const before = measuredToolingFixture();
    const after = rebalanceMeasuredSerialJobs(before, measuredPackingOptions);
    expect(after).toHaveLength(10);
    expect(sortedGroups(after)).toEqual(sortedGroups(before));
    expect(Math.max(...after.map((job) => job.predictedSeconds!))).toBe(351);
    expectEvery(
      after.filter((job) => job.groups.length > 1),
      (job) => job.predictedSeconds! <= 300,
    );
    expectEvery(
      after.filter((job) => job.predictedSeconds! > 300),
      (job) => job.groups.length === 1,
    );
    expectEvery(
      after,
      (job) =>
        job.planConcurrency === 1 &&
        job.timeoutMinutes === 20 &&
        (workers(job) === "2" || job.groups.every((group) => workers(group) === "2")),
    );
  });

  it.each([
    { profile: "native" as const, limit: 420, jobs: 2 },
    { profile: "main-validation" as const, limit: 420, jobs: 1 },
    { profile: "main-validation" as const, limit: 150, jobs: 2 },
  ])("packs $profile tooling within its $limit-second test budget", ({ profile, limit, jobs }) => {
    const before = measuredToolingFixture().slice(0, 2);
    const after = rebalanceMeasuredSerialJobs(before, {
      ...measuredPackingOptions,
      profile,
      estimateGroup: () => ({ seconds: 210, complete: true }),
      testSecondsLimit: () => limit,
    });
    expect(after).toHaveLength(jobs);
    expect(sortedGroups(after)).toEqual(sortedGroups(before));
    expectEvery(after, (job) => job.planConcurrency === 1 && job.timeoutMinutes === 20);
    expect(after.map((job) => job.predictedSeconds)).toEqual(jobs === 1 ? [420] : [210, 210]);
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
    expect(sortedGroups(packed)).toEqual(sortedGroups([...tooling, cli]));
    expectEvery(packed, (job) => job.planConcurrency === 1 && job.timeoutMinutes === 20);
    expect(packed.find((job) => job !== cli)?.predictedSeconds).toBe(440);
    const native = rebalanceMeasuredSerialJobs(tooling, {
      ...options,
      profile: "native",
      estimateGroup: () => ({ seconds: 220, complete: true }),
    });
    expect(native).toHaveLength(2);
    expectEvery(native, (job) => job.predictedSeconds === 220);
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
      expect(sortedGroups(after)).toEqual(sortedGroups(before));
      expect(Math.max(...after.map((job) => job.predictedSeconds!))).toBeLessThanOrEqual(720);
      expectEvery(after, (job) => job.planConcurrency === 1 && job.timeoutMinutes === 20);
      if (expectedJobs === 1) {
        expect(after[0]).toMatchObject({
          checkName: tail.checkName,
          shardName: tail.shardName,
          runner: DEFAULT_NODE_TEST_RUNNER,
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
          predictedSeconds: 660,
        });
      }
    },
  );

  it.each([measuredCompactFixture.cliTailJob, ...measuredCompactFixture.toolingTailJobs])(
    "splits observed pair $shardName with its child prices and runtime preparation",
    (fixture) => {
      const cli = fixture === measuredCompactFixture.cliTailJob;
      const before = structuredClone(fixture);
      const after = rebalanceMeasuredSerialJobs([before], measuredPackingOptions);
      expect(after).toHaveLength(2);
      expect(after.flatMap(jobGroups)).toEqual(before.groups);
      if (cli) {
        expect(new Set(after.map((job) => job.checkName)).size).toBe(2);
      }
      for (const [index, job] of after.entries()) {
        expectInherited(
          job,
          before,
          "runner",
          "planConcurrency",
          "requiresDist",
          "timeoutMinutes",
          "env",
        );
        expectFields(job, {
          pretestBuildMode: cli ? undefined : before.groups[index]!.pretestBuildMode,
        });
        if (cli) {
          // CLI fixture walls include 60s of setup, outside the test-step price.
          expect(job.predictedSeconds).toBe(
            measuredCompactFixture.cliChildJobWallSeconds[index]! - 60,
          );
        } else {
          expect(job.predictedSeconds).toBeGreaterThanOrEqual(before.predictedSeconds!);
        }
      }
    },
  );

  it.each([
    { change: "runner", override: { runner: EXTRA_LARGE_NODE_TEST_RUNNER } },
    { change: "workers", override: { env: { OPENCLAW_VITEST_MAX_WORKERS: "1" } } },
    { change: "concurrency", override: { planConcurrency: 2 } },
  ])(
    "does not spend serial tooling observations after the $change contract changes",
    ({ override }) => {
      const before = measuredToolingFixture();
      before.forEach((job) => Object.assign(job, structuredClone(override)));
      expect(rebalanceMeasuredSerialJobs(before, measuredPackingOptions)).toEqual(before);
    },
  );

  it("reprices changed selectors without spending their expired native observation", () => {
    const observed = findGroupJob(measuredToolingFixture(), "core-tooling-7-hosted-1")!;
    const options = {
      ...measuredPackingOptions,
      estimateGroup: () => ({ seconds: 200, complete: true }),
    };
    expect(rebalanceMeasuredSerialJobs([observed], options)[0]!.predictedSeconds).toBe(276);
    const changed = structuredClone(observed);
    changed.groups[0]!.includePatterns!.push("test/scripts/unmeasured-fixture.test.ts");
    const after = rebalanceMeasuredSerialJobs([changed], options);
    expectFields(after[0], { predictedSeconds: 200, groups: changed.groups });
  });

  it.each([
    { expired: false, prices: [218, 351] },
    { expired: true, prices: [320, 320] },
  ])(
    "splits expensive tooling pairs without discounting prices (expired: $expired)",
    ({ expired, prices }) => {
      const before = expired
        ? structuredClone(measuredCompactFixture.toolingTailJobs[1]!)
        : measuredToolingFixture()[7]!;
      if (expired) {
        before.groups.forEach((group, index) => {
          group.timing_key = `unmeasured-child-${index}`;
          group.includePatterns!.push(`test/scripts/unmeasured-fixture-${index}.test.ts`);
        });
      }
      const after = rebalanceMeasuredSerialJobs([before], {
        ...measuredPackingOptions,
        estimateGroup: (group) => ({
          seconds: expired ? 320 : group.shard_name === "core-tooling-12-hosted-1" ? 218 : 351,
          complete: true,
        }),
      });
      expect(after).toHaveLength(2);
      expect(after.flatMap(jobGroups)).toEqual(before.groups);
      expect(after.map((job) => job.predictedSeconds)).toEqual(prices);
    },
  );

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
      const expensive = required(after.find((job) => job.checkName === before[0]!.checkName));
      expectFields(expensive, { groups: before[0]!.groups, predictedSeconds: 900 });
      expect(sortedGroups(after)).toEqual(sortedGroups(before));
    },
  );

  it("counts every placement stage against the compact cap", () => {
    const options = compactOptions("runson", "pull-request");
    const stages = ["hybrid", "runson"].map((profile) =>
      committedPlan(options.compactMode, profile),
    );
    const compactNodeJobCap = Math.max(
      ...stages.map((jobs) => jobs.filter((job) => !job.requiresDist).length),
    );
    expect(bundleTests({ ...options, compactNodeJobCap })).toEqual(stages[1]);
    expect(() => bundleTests({ ...options, compactNodeJobCap: compactNodeJobCap - 1 })).toThrow(
      /compact (?:hybrid|runson) node test plan exceeds/u,
    );
  });

  it("keeps precise RunsOn targets and their canonical child policies", () => {
    const cronTarget = "src/cron/validate-timestamp.test.ts";
    const siblingTarget = "src/cli/update-dry-run-state.process.test.ts";
    const cliTarget = "src/cli/nodes-cli.coverage.test.ts";
    const targets = [cronTarget, siblingTarget, cliTarget];
    const hybrid = required(selectTests(targets, { runnerBackend: "hybrid" }));
    const runson = required(selectTests(targets, { runnerBackend: "runson" }));

    expect(sortedGroups(runson)).toEqual(sortedGroups(hybrid));
    expectSameEntries(sortedGroups(runson).flatMap(optionalPatterns), targets);
    expect(runson.filter((job) => job.runner === "runson-c8i-8xlarge")).toMatchObject([
      { groups: [{ includePatterns: [cronTarget] }], planConcurrency: 1 },
    ]);
    expect(findFileJob(runson, siblingTarget)?.runner).toBe(
      findFileJob(hybrid, siblingTarget)?.runner,
    );
    expect(findFileJob(runson, cliTarget)?.runner).toBe("blacksmith-16vcpu-ubuntu-2404");
  });

  it("discovers only tooling files for a cold precise tooling plan", () => {
    const result = spawnNodeEvalSync(`
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      let sourceReads = 0;
      let fullInventoryReads = 0;
      const spawnSync = childProcess.spawnSync;
      childProcess.spawnSync = function(command, args, ...options) {
        if (command === "git" && args?.[0] === "ls-files" && !args.includes("--")) fullInventoryReads += 1;
        return spawnSync.call(this, command, args, ...options);
      };
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
        fullInventoryReads,
        distOwners: plan?.filter((shard) => shard.requiresDist).map((shard) => shard.groups.flatMap((group) => group.configs)).flat().sort(),
        selected: plan?.filter((shard) => !shard.requiresDist).flatMap((shard) => shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? []).sort(),
      }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      importReads: 0,
      sourceReads: 0,
      fullInventoryReads: 0,
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
      useFixtureProjects((config) =>
        indivisible
          ? embeddedAgentVitestProjectOwners.some((owner) => owner.config === config)
          : config === agentVitestProjectOwners.tools.config,
      );

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
      spyTimings().mockImplementation((profile) => timings[profile]);
      vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      const options = { compactMode: "push" as const, runnerBackend };
      const selectOwnerJob = (plan: CompactNodeTestShard[]) =>
        required(
          plan.find((job) =>
            job.groups.some((group) =>
              indivisible
                ? group.includePatterns?.includes(pricedFile)
                : group.shard_name === owner,
            ),
          ),
        );
      const initial = selectOwnerJob(bundleTests(options));
      expect(initial.predictedSeconds).toBe(serialEstimate);
      expect(initial.groups).toHaveLength(1);
      const group = initial.groups[0]!;
      const key = required(group.timing_key);
      expect(key).toBe(`${group.shard_name}#file-parallel`);
      timings.blacksmith[key] = 24;
      timings.github[key] = 24;
      const refitted = selectOwnerJob(bundleTests(options));
      // New wall samples override serial/file floors and must not be divided again.
      expectFields(refitted, {
        predictedSeconds: parallelEstimate,
        groups: initial.groups,
      });
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
      mockPlanShards(() => [fixtureShard("agentic", [config], configPath("full-agentic"))]);
      await mockFastPaths([fastModel]);
      mockTrackedFiles((root: string) => (root === "src/agents" ? files : []));
      mockPlanTimings(() => seconds);
      mockFixture("metadata", () => ({
        ...shardMetadata,
        estimateVitestTestFileSeconds: fileWeights,
      }));
      mockFixture("build", () => ({
        ...buildPrerequisites,
        resolveVitestPretestBuildMode: buildMode,
        listVitestRuntimeConsumerFiles: () => [runtimeFile],
      }));
      const { createNodeTestShardBundles: createPlan } = await loadPlanModule([
        "build",
        "metadata",
        "fast",
      ]);

      const options = compactOptions(runnerBackend, "push");
      const predicted = (jobs: CompactNodeTestShard[]) => sumOptionalSeconds(jobs);
      const baseline = createPlan(options);
      // The authentication fixture is indivisible; only the two models share work.
      expect(predicted(baseline)).toBe(runnerBackend === "hybrid" ? 122 : 140);
      expectEvery(baseline.flatMap(jobGroups), (group) => workers(group) === "2");
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
      expectPlanFiles(measured, files);
      expectEvery(
        measured.flatMap(jobGroups).filter((group) => group.shard_name.startsWith(models)),
        (group) => group.timing_key?.startsWith(`${models}-parallel`),
      );
      if (runnerBackend !== "blacksmith") {
        const modelGroups = measured
          .flatMap(jobGroups)
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
        expectSameEntries(
          childMeasured
            .flatMap(jobGroups)
            .filter((group) => group.shard_name.startsWith(models))
            .map((group) => required(group.timing_key)),
          modelGroups.map((group) => required(group.timing_key)),
        );
        for (const group of modelGroups) {
          delete seconds[group.timing_key!];
        }
      }

      seconds[models] = 0;
      seconds[`${models}-parallel`] = 0;
      seconds[singleton] = 0;
      seconds[commands] = 74;
      const legacy = splitGeneration([config], commands, [
        [runtimeFile],
        [commandPeers[0]!],
        [commandPeers[1]!],
      ]);
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
      const runtimeJob = findFileJob(migrated, runtimeFile);
      // Merging the two sibling stripes preserves the singleton's 28s measurement.
      expect(runtimeJob?.predictedSeconds).toBe(
        runnerBackend === "github" ? 124 : runnerBackend === "hybrid" ? 85 : 88,
      );
      seconds[`${commands}-parallel`] = 200;
      const projectedRuntimeJob = findFileJob(createPlan(options), runtimeFile);
      expect(projectedRuntimeJob?.predictedSeconds).toBe(runnerBackend === "github" ? 141 : 105);
      const runtimeGroup = projectedRuntimeJob!.groups.find((group) =>
        group.includePatterns?.includes(runtimeFile),
      )!;
      expect(runtimeGroup.includePatterns).toEqual([runtimeFile]);
      seconds[runtimeGroup.timing_key!] = 10;
      const refitted = findFileJob(createPlan(options), runtimeFile);
      // An exact parallel sample replaces the migrated serial observation.
      expect(refitted?.predictedSeconds).toBe(runnerBackend === "github" ? 106 : 70);
    },
  );

  it.each([undefined, "8"])(
    "retains isolated Gateway timing history (previous workers=%s)",
    (previousWorkers) => {
      const owner = "agentic-gateway-server-isolated";
      const configs = [
        configPath("gateway-server-isolated"),
        configPath("gateway-database-workers"),
      ];
      useFixtureProjects((config) => configs.includes(config));

      const previous: Record<string, number> = { [owner]: 100 };
      spyTimings().mockImplementation((profile) =>
        profile === "blacksmith" ? previous : { [owner]: 100 },
      );
      const options = { compactMode: "push" as const, runnerBackend: "hybrid" };
      const initial = bundleTests(options).flatMap(jobGroups);
      expect(initial.map((group) => workers(group))).toEqual(["2", "2"]);
      const legacy = splitGeneration(
        configs,
        owner,
        initial.map((group) => group.includePatterns!),
        previousWorkers ? { OPENCLAW_VITEST_MAX_WORKERS: previousWorkers } : undefined,
      );
      for (const [index, key] of legacy.timingKeys.entries()) {
        previous[key] = 247 + index;
      }
      const expanded = bundleTests(options);
      expect(sumRequiredSeconds(expanded)).toBeGreaterThanOrEqual(495);
      expectPlanFiles(expanded, initial.flatMap(requiredPatterns), requiredPatterns);
    },
  );

  it.each(["hybrid", "github"])(
    "gates Gateway method workers without changing complete coverage (%s)",
    (runnerBackend) => {
      const owner = "agentic-gateway-methods";
      const configs = new Set([
        configPath("gateway-methods"),
        configPath("gateway-methods-isolated"),
      ]);
      useFixtureProjects((config) => configs.has(config));

      const timings: Record<string, number> = { [owner]: 120 };
      spyTimings().mockReturnValue(timings);
      vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);

      const jobs = bundleTests({
        compactMode: "push",
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyRuntimeTests: true,
      });
      const groups = jobs.flatMap(jobGroups);
      expect(groups.length).toBeGreaterThan(0);
      expectSameEntries(groups.flatMap(optionalPatterns), [
        ...listMatchedTestFiles(createGatewayMethodsVitestConfig({})),
        ...listMatchedTestFiles(createGatewayMethodsIsolatedVitestConfig({})),
      ]);
      for (const job of jobs) {
        expect(job.planConcurrency).toBe(1);
        if (runnerBackend !== "github") {
          expect(job.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
          expect(workers(job)).toBeUndefined();
        }
        for (const group of job.groups) {
          const measured = runnerBackend !== "github";
          expect(workers(group)).toBe(measured ? "4" : "2");
          expectFields(group, {
            minTotalMemoryBytes: measured ? 28 * 1024 ** 3 : undefined,
            fallbackMaxWorkers: measured ? 2 : undefined,
          });
          expect(group.timing_key?.includes("#workers-4") ?? false).toBe(measured);
        }
      }
      if (runnerBackend !== "github") {
        const fullFiles = groups.flatMap(optionalPatterns);
        const excluded = required(fullFiles[0]);
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
          const reduced = bundleTests({
            compactMode: "pull-request",
            runnerBackend,
            includeProofTests: true,
            includeReleaseOnlyPluginShards: false,
            includeReleaseOnlyRuntimeTests: false,
          });
          const predicted = sumRequiredSeconds(reduced);
          expect(predicted, key).toBeGreaterThanOrEqual(seconds);
          expect(predicted, key).toBeLessThan(seconds + reduced.length);
          expectPlanFiles(
            reduced,
            fullFiles.filter((file) => file !== excluded),
          );
        }
      }
    },
  );

  it("retains complete agentic-gateway-core-2 timing floors and ignores partial generations", () => {
    const { owner, config, previousWorkers } = {
      owner: "agentic-gateway-core-2",
      config: configPath("gateway-core"),
      previousWorkers: "2",
    };

    useFixtureProjects((candidate) => candidate === config);

    let overlays: Record<"blacksmith" | "github", Readonly<Record<string, number>>> = {
      blacksmith: { [owner]: 165 },
      github: { [owner]: 253 },
    };
    spyTimings().mockImplementation((profile) => overlays[profile]);
    const options = compactOptions("hybrid", "pull-request");
    const initialPlan = bundleTests(options);
    const ownerGroups = (plan: typeof initialPlan) =>
      plan
        .flatMap(jobGroups)
        .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner)
        .toSorted((left, right) => left.shard_name.localeCompare(right.shard_name));
    const initial = ownerGroups(initialPlan);
    expect(initial).toHaveLength(2);
    const originalFiles = initial.flatMap(requiredPatterns).toSorted();
    const previousGeneration = splitGeneration(
      initial[0]!.configs,
      owner,
      initial.map((group) => group.includePatterns!),
      previousWorkers
        ? { ...initial[0]!.env, OPENCLAW_VITEST_MAX_WORKERS: previousWorkers }
        : initial[0]!.env,
    );
    overlays.blacksmith = {
      ...overlays.blacksmith,
      ...Object.fromEntries(previousGeneration.timingKeys.map((key, index) => [key, 247 + index])),
    };

    const expanded = ownerGroups(bundleTests(options));
    expect(expanded).toHaveLength(4);
    expect(expanded.flatMap(requiredPatterns).toSorted()).toEqual(originalFiles);
    expectEvery(expanded, (group) => workers(group) === undefined);
    const stripes = expanded.map((group) => group.includePatterns!);
    function swappedGeneration(a: number, b: number) {
      const changed = stripes.map((patterns) => patterns.slice());
      const first = changed[a]!.shift()!;
      const second = changed[b]!.shift()!;
      changed[a]!.push(second);
      changed[b]!.push(first);
      return splitGeneration(expanded[0]!.configs, owner, changed, expanded[0]!.env);
    }
    const partialA = swappedGeneration(0, 1);
    const partialB = swappedGeneration(2, 3);
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
    const incomplete = bundleTests(options).flatMap(jobGroups);
    expect(incomplete.filter((group) => group.shard_name === owner)).toHaveLength(1);
    expect(
      incomplete.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)),
    ).toHaveLength(0);

    overlays.blacksmith = {
      ...overlays.blacksmith,
      ...Object.fromEntries(expanded.map((group) => [group.timing_key!, 124])),
    };

    const stable = ownerGroups(bundleTests(options));
    expect(stable).toHaveLength(4);
    expect(stable.map((group) => group.timing_key)).toEqual(
      expanded.map((group) => group.timing_key),
    );
    expect(stable.flatMap(requiredPatterns).toSorted()).toEqual(originalFiles);
  });

  it.each([
    { profile: "blacksmith", owner: "auto-reply-reply-state-routing", fallback: 60, measured: 99 },
    { profile: "hybrid", owner: "auto-reply-reply-state-routing", fallback: 52, measured: 99 },
    { profile: "blacksmith", owner: "auto-reply-reply-dispatch-core", fallback: 120, measured: 99 },
  ])(
    "prices $owner on $profile at two workers without discounting new measurements",
    ({ profile, owner, fallback, measured }) => {
      const config = configPath("auto-reply-reply");
      useFixtureProjects((candidate) => candidate === config);

      const owners = planTests();
      const timings = Object.fromEntries(owners.map((shard) => [shard.shardName, 0]));
      timings[owner] = 120;
      spyTimings().mockReturnValue(timings);
      const options = compactOptions(profile, "pull-request");
      const before = bundleTests(options);
      expect(sumRequiredSeconds(before)).toBe(fallback);
      expectEvery(before.flatMap(jobGroups), (group) => workers(group) === "2");
      const current = required(
        before.flatMap(jobGroups).find((group) => group.shard_name === owner),
      );
      expect(current.timing_key).not.toBe(owner);
      const files = required(current.includePatterns);
      if (files.length > 1) {
        const legacy = splitGeneration(current.configs, owner, [files.slice(0, 1), files.slice(1)]);
        const mismatched = splitGeneration(current.configs, owner, [files.slice(1)]);
        const complete = Object.fromEntries(legacy.timingKeys.map((key) => [key, 120]));
        for (const scenario of [
          { observations: { [legacy.timingKeys[0]!]: 240 }, expected: fallback },
          { observations: { [mismatched.timingKeys[0]!]: 240 }, expected: fallback },
          { observations: complete, expected: profile === "hybrid" ? 104 : 120 },
        ]) {
          Object.assign(timings, scenario.observations);
          const plan = bundleTests(options);
          expect(sumRequiredSeconds(plan)).toBe(scenario.expected);
          for (const key of Object.keys(scenario.observations)) {
            delete timings[key];
          }
        }
        Object.assign(timings, complete);
      }
      timings[current.timing_key!] = 99;
      const after = bundleTests(options);
      expect(sumRequiredSeconds(after)).toBe(measured);
      expectPlanFiles(after, owners.flatMap(requiredPatterns), requiredPatterns);
    },
  );

  it("retains each singleton auto-reply stripe's full cost when splitting a parallel parent", () => {
    const config = configPath("auto-reply-reply");
    const owner = "auto-reply-reply-state-routing";
    const files = required(
      defaultShards.find((shard) => shard.shardName === owner)?.includePatterns,
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
        ...Object.fromEntries(planTests().map((shard) => [shard.shardName, 0])),
        [owner]: 400,
      };
      spyTimings().mockReturnValue(timings);
      const options = compactOptions("github", "pull-request");
      const plan = bundleTests(options);
      const children = plan.flatMap((job) =>
        job.groups.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)),
      );
      expect(children).toHaveLength(2);
      expect(children.map((group) => group.includePatterns?.length)).toEqual([1, 1]);
      expect(children.flatMap(requiredPatterns).toSorted()).toEqual(files);
      expect(sumRequiredSeconds(plan)).toBe(400);
      Object.assign(timings, Object.fromEntries(children.map((group) => [group.timing_key!, 200])));
      const measured = bundleTests(options);
      expect(sumRequiredSeconds(measured)).toBe(400);
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

  it("prices serial Gateway server measurements at two workers and preserves parallel samples (github)", () => {
    const runnerBackend = "github";

    const config = configPath("gateway-server");
    const owner = "agentic-control-plane-agent-chat";
    useFixtureProjects((candidate) => candidate === config);

    const timings: Record<string, number> = { [owner]: 540 };
    spyTimings().mockReturnValue(timings);
    vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
    const options = { compactMode: "pull-request" as const, runnerBackend };
    const select = (includeReleaseOnlyRuntimeTests = true) =>
      bundleTests({ ...options, includeReleaseOnlyRuntimeTests })
        .flatMap(jobGroups)
        .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner);
    const inherited = select();
    expect(inherited).toHaveLength(2);
    expectEvery(inherited, (group) => workers(group) === "2");
    const parallelParent = required(
      parseCompactSplitTimingKey(inherited[0]!.timing_key!)?.parentShardName,
    );
    expect(parallelParent).not.toBe(owner);
    const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...serialEnv } = inherited[0]!.env!;
    const serialGeneration = splitGeneration(
      [config],
      owner,
      inherited.map((group) => group.includePatterns!),
      serialEnv,
    );
    timings[serialGeneration.timingKeys[0]!] = 500;
    expect(select()).toHaveLength(2);
    timings[serialGeneration.timingKeys[1]!] = 500;
    expect(select()).toHaveLength(4);
    timings[`${owner}-parallel-native-serial`] = 440;
    timings[parallelParent] = 440;
    const measured = select();
    expect(measured).toHaveLength(3);
    expectSameEntries(measured.flatMap(requiredPatterns), inherited.flatMap(requiredPatterns));
    const reduced = select(false);
    expect(reduced).toHaveLength(measured.length);
    expectSameEntries(
      reduced.flatMap(requiredPatterns),
      measured.flatMap(requiredPatterns).filter((file) => !isReleaseOnlyRuntimeTestFile(file)),
    );
    expect(
      reduced.map((group) => parseCompactSplitTimingKey(group.timing_key!)?.parentShardName),
    ).toEqual(reduced.map(() => `changed-${parallelParent}`));
    timings[`changed-${owner}-parallel-native-serial`] = 180;
    expect(select(false).length).toBeLessThan(reduced.length);
    expect(select()).toEqual(measured);
  });

  it("charges native fixture spans before discounting concurrent Gateway work", async () => {
    const config = configPath("gateway-server");
    const owner = "agentic-control-plane-agent-chat";
    const files = [
      gatewayServerSerialTestFiles[0]!,
      "src/gateway/server.chat.fixture-a.test.ts",
      "src/gateway/server.chat.fixture-b.test.ts",
    ];
    const timings: Record<string, number> = { [owner]: 230 };
    mockProject("agentic", config, "src/gateway", files, timings);
    const { createNodeTestShardBundles: createPlan } = await loadPlanModule();

    const options = { compactMode: "push" as const, runnerBackend: "blacksmith" };
    const initial = createPlan(options);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.predictedSeconds).toBe(130);
    const parentKey = required(initial[0]?.groups[0]?.timing_key);
    expect(parentKey).toContain("native-serial");
    timings[parentKey] = 230;
    const split = createPlan(options);
    expect(split.map((job) => job.predictedSeconds).toSorted((a, b) => a! - b!)).toEqual([30, 200]);
    expectPlanFiles(split, files, requiredPatterns);
    const native = required(findFileJob(split, files[0]!));
    expect(native.groups.flatMap(requiredPatterns)).toEqual([files[0]]);
    expect(native.predictedSeconds).toBe(30);
  });

  it("keeps parallel singleton measurements separate from the legacy serial floor", async () => {
    const config = configPath("gateway-server");
    const owner = "agentic-control-plane-runtime-server";
    const files = [
      "src/gateway/server-sidecar-retention.test.ts",
      "src/gateway/server-file-fixtures.test.ts",
    ];
    const timings: Record<string, number> = { [owner]: 200 };
    mockProject("agentic", config, "src/gateway", files, timings);
    const { createNodeTestShardBundles: createPlan } = await loadPlanModule();

    const options = { compactMode: "push" as const, runnerBackend: "blacksmith" };
    const initial = createPlan(options);
    const groups = initial.flatMap(jobGroups);
    expect(groups.map((group) => group.includePatterns?.length)).toEqual([1, 1]);
    expectSameEntries(groups.flatMap(requiredPatterns), files);
    const keys = groups.map((group) => required(group.timing_key));
    const parent = required(parseCompactSplitTimingKey(keys[0]!)).parentShardName;
    const seconds = () => sumOptionalSeconds(createPlan(options));
    // One runtime preparation costs 60s; both singleton files retain their serial floor.
    expect(seconds()).toBe(260);
    // Two 300s files still cost 300s each when a 300s parallel parent is split.
    timings[`${owner}-parallel`] = 300;
    expect(seconds()).toBe(660);
    delete timings[`${owner}-parallel`];
    setTimingParts(timings, keys, 300);
    expect(seconds()).toBe(660);
    timings[parent] = 600;
    expect(seconds()).toBe(660);
    for (const key of keys) {
      delete timings[key];
    }
    expect(seconds()).toBe(660);
    setTimingParts(timings, keys, 300);
    timings[parent] = 400;
    expect(seconds()).toBe(660);
    delete timings[parent];
    setTimingParts(timings, keys, 30);
    expect(seconds()).toBe(120);
    timings[parent] = 700;
    expect(seconds()).toBe(120);
  });

  it("keeps oversized sparse groups nonempty on github", () => {
    const runnerBackend = "github";

    const native = planTests({ includeReleaseOnlyPluginShards: false });
    const targets = [1, 2].map((count) =>
      native.find(
        (shard) =>
          shard.includePatterns?.length === count && !shard.shardName.startsWith("core-tooling"),
      )!,
    );
    expectEvery(targets, Boolean);
    const original = testTimings.readCompactGroupTimings;
    spyTimings().mockImplementation((profile) => ({
      ...original(profile),
      ...Object.fromEntries(targets.map((target) => [target.shardName, 1_000])),
    }));
    const plan = bundleTests(compactOptions(runnerBackend, "push"));
    for (const target of targets) {
      const groups = plan
        .flatMap(jobGroups)
        .filter(
          (group) =>
            group.shard_name === target.shardName ||
            group.shard_name.startsWith(`${target.shardName}-hosted-`),
        );
      expectEvery(groups, (group) => (group.includePatterns?.length ?? 0) > 0);
      expectSameEntries(groups.flatMap(optionalPatterns), target.includePatterns!);
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
        ...planTests().find((shard) => shard.shardName === "core-runtime-config")!,
        includePatterns: listMatchedTestFiles(createRuntimeConfigVitestConfig({})),
      };
      const runtimeFiles = new Set(listVitestRuntimeConsumerFiles(target.configs));
      const runtimeConsumers = target.includePatterns.filter((file) => runtimeFiles.has(file));
      const buildMode = "runtime";
      useFixtureProjects((config) => target.configs.includes(config));

      spyTimings().mockImplementation((profile) => ({
        [target.shardName]: profile === slowerProfile ? 400 : 100,
      }));
      const plan = bundleTests(compactOptions(runnerBackend, "pull-request"));
      const groups = plan
        .flatMap(jobGroups)
        .filter((group) => group.shard_name.startsWith(`${target.shardName}-hosted-`));
      // Runtime consumers share one isolated build child; its fixed build may
      // exceed the cap. Remaining work needs three stripes on both profiles.
      expect(groups).toHaveLength(4);
      if (runnerBackend === "github") {
        expectEvery(
          plan.filter((job) => job.predictedSeconds! > 150),
          (job) => {
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
          },
        );
      }
      expect(
        groups
          .filter((group) => group.pretestBuildMode !== undefined)
          .map(({ pretestBuildMode, includePatterns }) => ({ pretestBuildMode, includePatterns })),
      ).toEqual([{ pretestBuildMode: buildMode, includePatterns: runtimeConsumers }]);
      for (const job of plan) {
        if (
          job.groups.some((group) => groups.includes(group) && group.pretestBuildMode === undefined)
        ) {
          expect(job.predictedSeconds, `${runnerBackend}/${slowerProfile}`).toBeLessThanOrEqual(
            150,
          );
        }
      }
      expectSameEntries(groups.flatMap(optionalPatterns), target.includePatterns!);
    },
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the core root budget guard alongside changed messaging test owners", () => {
    const guard = "test/scripts/tsgo-core-test-shards.test.ts";
    const changed = "src/infra/outbound/outbound-send-service.accepted-outcomes.test.ts";
    const shards = required(changedTests([changed]));
    const targets = shards.flatMap((shard) =>
      (shard.targets ?? []).concat((shard.groups ?? []).flatMap(optionalPatterns)),
    );
    expect(targets).toContain(changed);
    expect(targets.filter((target) => target === guard)).toEqual([guard]);
    for (const changedPath of [
      "src/auto-reply/reply/new.test.tsx",
      "src/infra/outbound/new.test.ts",
      "src/media/new.test.ts",
      "test/tsconfig/tsconfig.core.test.messaging.json",
      "test/tsconfig/tsconfig.core.test.ui-e2e-chat.json",
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
      ["test/scripts/pr-worktree-provision.test.ts", configPath("infra")],
      ["test/scripts/eager-import-closure.test.ts", configPath("tooling")],
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
    const shards = required(changedTests([manifest]));
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
    const shards = required(changedTests([changedTest], { selectionMode: "aggressive" }));
    const groups = shards.flatMap((shard) => shard.groups ?? []);
    const selected = [
      ...shards.flatMap((shard) => shard.targets ?? []),
      ...groups.flatMap(optionalPatterns),
    ];
    expect(selected).not.toContain(changedTest);
    const owners = groups.filter((group) => group.includePatterns?.includes(wrapper));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.configs).toEqual([configPath("tooling")]);
  });

  it("matches policy owners with literal and native glob semantics", () => {
    const changedPath = "ui/src/styles/base.css";
    expect(resolvePolicyTestTargets([changedPath])).not.toEqual([]);
    const themeOwners = [
      "ui/src/styles/base-theme-tokens.node.test.ts",
      "ui/src/styles/base-theme-contrast.node.test.ts",
    ];
    for (const path of [changedPath, "ui/public/themes/tide.css", "ui/src/styles/./base.css"]) {
      expect(isPolicyTestOwnedPath(path), path).toBe(true);
      expect(resolvePolicyTestTargets([path], { completeOwnersOnly: true }), path).toEqual([
        ...themeOwners,
        ...(path.includes("/themes/") ? [] : ["ui/src/styles/cursor-policy.node.test.ts"]),
      ]);
    }
    expect(
      resolvePolicyTestTargets(["ui/src/pages/chat/view.ts"], { completeOwnersOnly: true }),
    ).toEqual([]);
    for (const lookalike of [` ${changedPath}`, String.raw`ui\src\pages\chat\view.ts`]) {
      expect(isPolicyTestOwnedPath(lookalike), lookalike).toBe(false);
      expect(resolvePolicyTestTargets([lookalike]), lookalike).toEqual([]);
    }
  });

  it("bounds Gateway cache collections without dropping or repeating owner files", () => {
    const config = configPath("gateway-methods");
    const groups = createVitestCacheWarmGroups().filter((group) => group.configs.includes(config));
    const files = groups.flatMap(optionalPatterns);
    expect(groups.length).toBeGreaterThan(1);
    expectEvery(groups, (group) => group.includePatterns!.length <= 32);
    expect(new Set(groups.map(groupName)).size).toBe(groups.length);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toEqual(nodeTestInventory.listNodeTestConfigFiles(config));
    expect(
      createVitestCacheWarmGroups().filter((group) =>
        group.configs.includes(configPath("gateway-methods-isolated")),
      ),
    ).toHaveLength(1);
  });

  it("bounds the hybrid hosted seed to real consumer configs without runtime builds", () => {
    const groups = createVitestCacheWarmGroups("hybrid-hosted");
    expect(groups).toHaveLength(7);

    expectEvery(groups, (group) => (group.includePatterns?.length ?? 0) > 0);
    const files = groups.flatMap(optionalPatterns);
    expect(files).toHaveLength(16);
    expectEvery(files, (file) => existsSync(file));
    expect(buildPrerequisites.resolveVitestPretestBuildMode(groups)).toBeUndefined();
    const tooling = required(
      groups.find((group) => group.shard_name === "cache-warm:hosted-tooling"),
    );
    expect(
      createVitestRunSpecs(required(tooling.includePatterns), {
        baseEnv: { CI: "true", OPENCLAW_TEST_PROJECTS_PARALLEL: "3" },
      }).map((spec) => spec.config),
    ).toEqual(tooling.configs);
    const configs = groups.flatMap((group) => group.configs);
    expect(configs).toContain(configPath("tooling"));
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
    const owner = required(
      planTests(options).find((shard) => shard.shardName === "agentic-gateway-server-isolated"),
    );
    const stripes = bundleTests(options).filter((shard) =>
      shard.shardName.startsWith("agentic-gateway-server-isolated-"),
    );
    expect(stripes.length).toBeGreaterThan(1);
    const timingKeys = stripes.map((stripe) => required(stripe.timing_key));
    expect(new Set(timingKeys).size).toBe(stripes.length);
    expect(timingKeys).not.toContain(owner.timing_key);
    expect(stripes.flatMap(optionalPatterns).toSorted()).toEqual(owner.includePatterns?.toSorted());
    const timingParts = timingKeys.map((key) => required(parseCompactSplitTimingKey(key)));
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
      const timings = spyTimings().mockReturnValue({});
      const options = compactOptions(profile, "pull-request");
      const fallback = bundleTests(options);
      const tuiJob = (plan: typeof fallback) => findGroupJob(plan, "core-runtime-tui-pty");
      expectFields(tuiJob(fallback), {
        pretestBuildMode: "runtime",
        predictedSeconds: legacy + preparation,
      });
      timings.mockImplementation((runner) => ({
        "core-runtime-tui-pty": runner === "blacksmith" ? 310 : 370,
        "removed-test-group": 999,
      }));
      const updated = bundleTests(options);
      expect(tuiJob(updated)?.groups.map(groupName)).toEqual(["core-runtime-tui-pty"]);
      expect(tuiJob(updated)?.predictedSeconds).toBe(measured + preparation);
      expect(findGroupJob(updated, "core-support-boundary")?.predictedSeconds).toBe(defaultSeconds);
      const groupNames = (plan: typeof fallback) =>
        plan.flatMap((shard) => shard.groups.map(groupName)).toSorted();
      expect(groupNames(updated)).toEqual(groupNames(fallback));

      // Two complete, compatible configs share setup without changing either
      // process envelope. Blacksmith placements request capacity for overlapping plans.
      const fixtureConfigs = new Set([configPath("hooks"), configPath("secrets")]);
      const restore = selectFixtureProjects((config) => fixtureConfigs.has(config));
      try {
        const base = planTests(options);
        expect(base).toHaveLength(2);
        const groupSeconds = profile === "github" ? 70 : 170;
        timings.mockReturnValue(
          Object.fromEntries(base.map((shard) => [shard.shardName, groupSeconds])),
        );
        const packed = bundleTests(options);
        expect(packed).toHaveLength(1);
        expectFields(packed[0], {
          groups: base.map(({ checkName: _checkName, shardName, ...group }) => ({
            ...group,
            shard_name: shardName,
          })),
          planConcurrency: profile === "github" ? 1 : 2,
          runner: profile === "github" ? base[0]?.runner : EXTRA_LARGE_NODE_TEST_RUNNER,
          predictedSeconds: groupSeconds * 2,
        });
      } finally {
        restore();
      }

      // Cheap envelopes use the time budget instead of creating extra
      // runners at ten groups; serial placements keep their existing count limit.
      timings.mockReturnValue(
        Object.fromEntries(planTests(options).map((shard) => [shard.shardName, 1])),
      );
      const dense = bundleTests(options);
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
    const config = configPath("gateway-server");
    const files = [
      "src/gateway/server.chat.fixture-a.test.ts",
      "src/gateway/server.chat.fixture-b.test.ts",
    ];
    const timings: Record<string, number> = {
      "agentic-control-plane-agent-chat-parallel": 300,
      "core-runtime-hooks": 40,
    };
    vi.resetModules();
    mockPlanShards(() => [
      fixtureShard("agentic", [config]),
      fixtureShard("core-runtime", [configPath("hooks")], config),
    ]);
    mockTrackedFiles((root: string) => (root === "src/gateway" ? files : []));
    mockPlanTimings(() => timings);
    const { createNodeTestShardBundles: createPlan } = await loadPlanModule();

    const options = { compactMode: "push" as const, runnerBackend: "hybrid" };
    const stripes = (plan: readonly CompactNodeTestShard[]) =>
      plan
        .flatMap(jobGroups)
        .filter((group) => group.configs.includes(config))
        .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
    const before = createPlan(options);
    const originalStripes = stripes(before);
    expect(originalStripes).toHaveLength(2);
    expect(originalStripes.map((group) => group.includePatterns?.length)).toEqual([1, 1]);
    expect(originalStripes.flatMap(requiredPatterns).toSorted()).toEqual(files);
    for (const group of originalStripes) {
      expect(group.timing_key).toBeDefined();
      expect(timings[group.timing_key!]).toBeUndefined();
    }
    timings["core-runtime-hooks"] = 120;
    const after = createPlan(options);
    expect(stripes(after)).toEqual(originalStripes);
    const seconds = (plan: typeof before) => sumOptionalSeconds(plan);
    expect(seconds(before)).toBe(640);
    expect(seconds(after) - seconds(before)).toBe(80);
  });

  it.each([
    { profile: "github", timingProfile: "github", addedSeconds: 40 },
    { profile: "hybrid", timingProfile: "blacksmith", addedSeconds: 40 },
  ] as const)(
    "uses exact $profile child timings across sibling generations without changing partitions",
    ({ profile, timingProfile, addedSeconds }) => {
      useFixtureProjects((config) => config === agentVitestProjectOwners.support.config);

      const shardName = "agentic-agents-support-hosted-2";
      let directTimings: Readonly<Record<string, number>> = {};
      spyTimings().mockImplementation((runner): Readonly<Record<string, number>> => ({
        "agentic-agents-support": runner === "blacksmith" ? 165 : 253,
        ...(runner === timingProfile ? directTimings : {}),
      }));
      const options = compactOptions(profile, "push");
      const unmeasured = bundleTests(options);
      const initialGroup = unmeasured
        .flatMap(jobGroups)
        .find((group) => group.shard_name === shardName);
      expect(initialGroup?.timing_key).toMatch(
        /^agentic-agents-support#selector-.+#generation-.+#part-2-of-2#include-.+$/u,
      );
      const timingKey = initialGroup!.timing_key!;
      directTimings = { [timingKey]: 1 };
      const belowFloor = bundleTests(options);
      // Exact child observations supersede a stale parent projection in either direction.
      directTimings = { [timingKey]: 200 };
      const baseline = bundleTests(options);
      directTimings = { [timingKey]: 240 };
      const updated = bundleTests(options);
      const totalSeconds = (plan: typeof baseline) => sumOptionalSeconds(plan);
      const testPartition = (plan: typeof baseline) =>
        plan
          .flatMap(jobGroups)
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
        updated.flatMap(jobGroups).find((group) => group.shard_name === shardName)?.timing_key,
      ).toBe(timingKey);

      const previousGeneration = timingKey.replace(
        /#generation-[^#]+/u,
        "#generation-000000000000",
      );
      directTimings = { [previousGeneration]: 240 };
      const reused = bundleTests(options);
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
        expect(totalSeconds(bundleTests(options))).toBe(totalSeconds(unmeasured));
      }
    },
  );

  it.each([false, true])(
    "prices storage work without changing placement (companion: %s)",
    async (companion) => {
      const config = configPath("infra");
      const longest = MEASURED_STORAGE_WORK_TEST;
      const ordinary = "src/infra/sqlite-readonly-location.copy.test.ts";
      const measurements: Record<string, number> = { "core-runtime-infra-storage-state": 1 };
      mockProject("core-runtime", config, "src/infra", companion ? [ordinary] : [], measurements);
      mockOriginal("database", { databaseWorkerCoreTestFiles: [longest] });
      mockUnbuiltRuntime();
      const { createNodeTestShardBundles: createPlan } = await loadPlanModule([
        "build",
        "database",
      ]);

      const plan = createPlan({ compactMode: "push", runnerBackend: "blacksmith" });
      expectPlanFiles(plan, companion ? [longest, ordinary] : [longest], requiredPatterns);
      const longestJob = required(findFileJob(plan, longest));
      // The measured file span is indivisible; its wrapper is paid once even at more workers.
      expect(longestJob.predictedTestSeconds).toBeGreaterThanOrEqual(69.039 + 20);
      expect(longestJob.runner).toBe(DEFAULT_NODE_TEST_RUNNER);
      expectEvery(plan, (job) => job.predictedTestSeconds! <= 300);
    },
  );

  it("applies native solo prices without changing placement or hosted prices", async () => {
    const config = agentVitestProjectOwners.support.config;
    const file = "src/agents/harness/lifecycle.test.ts";
    const files = [file, "src/agents/harness/prompt-context.test.ts"];
    const measurements: Record<string, number> = { "agentic-agents-support": 240 };
    mockProject("agentic", config, "src/agents", files, measurements);
    mockOriginal("inventory", {
      listWholeConfigSplitFiles: (owner: string) =>
        owner === "agentic-agents-support" ? files : undefined,
    });
    mockUnbuiltRuntime();
    const {
      createNodeTestShardBundles: createPlan,
      createSelectedNodeTestShardBundles: createSelectedPlan,
    } = await loadPlanModule(["build", "inventory"]);
    const plan = createPlan({ compactMode: "push", runnerBackend: "blacksmith" });
    expectPlanFiles(plan, files, requiredPatterns);
    const job = required(findFileJob(plan, file));
    expectFields(job, { planConcurrency: 1, runner: EXTRA_LARGE_NODE_TEST_RUNNER });
    const selectedBefore = createSelectedPlan([file], { runnerBackend: "blacksmith" });
    const hostedBefore = createPlan({ compactMode: "push", runnerBackend: "github" });
    const key = required(createNativeSoloTimingKey(job.groups[0]!));
    measurements[key] = 123;
    for (const [before, after] of [
      [plan, createPlan({ compactMode: "push", runnerBackend: "blacksmith" })],
      [selectedBefore, createSelectedPlan([file], { runnerBackend: "blacksmith" })],
    ]) {
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      const expected = structuredClone(before!);
      for (const candidate of expected) {
        if (candidate.groups.some((group) => group.includePatterns?.includes(file))) {
          candidate.predictedSeconds = 123;
          candidate.predictedTestSeconds = 123;
        }
      }
      expect(after).toEqual(expected);
    }
    // A native price cannot reprice hosted execution of the same file.
    expect(createPlan({ compactMode: "push", runnerBackend: "github" })).toEqual(hostedBefore);
  });

  it.each([
    {
      owner: "core-runtime-config",
      config: configPath("runtime-config"),
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
      mockProject(suite, config, root, files, timings);
      mockOriginal("inventory", {
        listWholeConfigSplitFiles: (candidate: string) => (candidate === owner ? files : undefined),
      });
      mockUnbuiltRuntime();
      const { createNodeTestShardBundles: createPlan } = await loadPlanModule([
        "build",
        "inventory",
      ]);

      const options = { compactMode: "push" as const, runnerBackend };
      const before = createPlan(options);
      const [observed, sibling] = before.flatMap(jobGroups);
      expect(before.flatMap(jobGroups)).toHaveLength(2);
      expect(observed?.includePatterns).toHaveLength(35);
      const timingKey = observed!.timing_key!;
      timings[timingKey] = 362;
      const after = createPlan(options);
      const groups = after.flatMap(jobGroups);
      expect(groups.flatMap(requiredPatterns).toSorted()).toEqual(files);
      expect(groups.find((group) => group.timing_key === sibling!.timing_key)).toEqual(sibling);
      if (!pinned) {
        const measuredJob = required(
          after.find((job) => job.groups.some((group) => group.timing_key === timingKey)),
        );
        expect(measuredJob.groups).toEqual([observed]);
        expect(measuredJob.predictedTestSeconds).toBeGreaterThanOrEqual(362);
        expectFields(measuredJob, { planConcurrency: 1, runner: EXTRA_LARGE_NODE_TEST_RUNNER });
        expect(workers(measuredJob)).toBeUndefined();
        expect(workers(observed)).toBeUndefined();
        return;
      }
      const descendants = groups.filter((group) =>
        parseCompactSplitTimingKey(group.timing_key!)?.parentShardName.startsWith(timingKey),
      );
      expect(descendants.length).toBeGreaterThan(1);
      expectSameEntries(descendants.flatMap(requiredPatterns), observed!.includePatterns!);
      expectEvery(descendants, (group) => workers(group) === "2");
      expectEvery(after, (job) => job.predictedTestSeconds! <= 300);
      const totalSeconds = sumSeconds(after);
      expect(totalSeconds).toBeGreaterThanOrEqual(482);
      expect(totalSeconds).toBeLessThan(487);
      expect(createPlan(options)).toEqual(after);
      delete timings[timingKey];
      timings[timingKey.replace(/#generation-[^#]+/u, "#generation-000000000000")] = 362;
      expect(createPlan(options)).toEqual(after);

      const nestedKey = descendants[0]!.timing_key!;
      timings[nestedKey] = 3_600;
      const singleton = createPlan(options)
        .flatMap(jobGroups)
        .find(
          (group) => group.timing_key?.startsWith(nestedKey) && group.includePatterns?.length === 1,
        );
      expect(singleton).toBeDefined();
      timings[singleton!.timing_key!] = 500;
      const indivisible = createPlan(options).find((job) =>
        job.groups.some((group) => group.timing_key === singleton!.timing_key),
      );
      expect(indivisible?.groups).toHaveLength(1);
      expect(indivisible?.predictedTestSeconds).toBeGreaterThanOrEqual(500);
    },
  );

  it("partitions whole-config runtime consumers from ordinary serial CLI work", () => {
    const config = configPath("cli-process");
    useFixtureProjects((candidate) => candidate === config);

    const timings = spyTimings().mockReturnValue({});
    const options = compactOptions("hybrid", "push");

    const plan = bundleTests(options);
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
    expectPlanFiles(
      ordinaryJobs,
      catalogFiles.filter((file) => !runtimeFiles.includes(file)),
    );
    for (const job of plan) {
      expect(job).toMatchObject({ planConcurrency: 1, requiresDist: false });
      for (const group of job.groups) {
        expect(group.configs).toEqual([config]);
        expect(workers(group)).toBe("2");
        expectFields(group, { pretestBuildMode: job.pretestBuildMode, requiresDist: false });
      }
    }
    expectPlanFiles(plan, catalogFiles);

    // An oversized measured runtime child remains truthful and alone; ordinary
    // files must not inherit its prerequisite through a sibling exemption.
    timings.mockReturnValue(
      Object.fromEntries(runtimeJob!.groups.map((group) => [group.timing_key!, 100])),
    );
    const expensive = bundleTests(options).filter((job) => job.pretestBuildMode);
    expect(expensive).toHaveLength(1);
    // Runtime preparation is charged once, outside the predicted test step.
    expect(expensive[0]).toMatchObject({
      predictedSeconds: 160,
      predictedTestSeconds: 100,
      planConcurrency: 1,
    });
    expect(expensive[0]!.groups).toHaveLength(1);
    expect(expensive[0]!.groups[0]!.includePatterns?.toSorted()).toEqual(runtimeFiles);
  });

  it("shares the serial CLI budget between complete regular CLI children", () => {
    const config = configPath("cli");
    const files = ["src/cli/budget-a.test.ts", "src/cli/budget-b.test.ts"];
    useFixtureProjects((candidate) => candidate === config);

    const listFiles = nodeTestInventory.listWholeConfigSplitFiles;
    vi.spyOn(nodeTestInventory, "listWholeConfigSplitFiles").mockImplementation((name) =>
      name === "agentic-cli" ? files : listFiles(name),
    );
    vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockReturnValue(120);
    const timings = spyTimings().mockReturnValue({
      "agentic-cli": 240,
    });
    const options = compactOptions("hybrid", "pull-request");

    const plan = bundleTests(options);
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
      const separate = bundleTests(options);
      expect(separate).toHaveLength(2);
      expectEvery(separate, (row) => row.planConcurrency === 1 && row.groups.length === 1);
      expect(separate.flatMap(jobGroups)).toEqual(job!.groups);
    }
  });

  it("spends the hybrid CLI budget only on complete affordable non-build bins", () => {
    const originalProcessFiles = cliProcessTestFiles.slice();
    const configs = new Set([configPath("cli"), configPath("cli-process")]);
    const restore = selectFixtureProjects((config) => configs.has(config));
    const timings = spyTimings().mockReturnValue({
      "agentic-cli": 136,
    });
    const options = compactOptions("hybrid", "pull-request");
    try {
      const plan = bundleTests(options);
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
        job.groups.filter((group) => group.configs.includes(configPath("cli-process"))),
      );
      expectSameEntries(
        processGroups.flatMap(optionalPatterns),
        listMatchedTestFiles(createCliProcessVitestConfig({})),
      );
      expectEvery(combined, (job) => job.predictedSeconds! <= 250 && job.planConcurrency === 1);
      for (const job of plan.filter((candidate) => candidate.pretestBuildMode)) {
        expect(job.predictedSeconds).toBeLessThanOrEqual(150);
        expectEvery(job.groups, (group) => group.pretestBuildMode === "runtime");
      }
      const combinedProcessGroups = combined
        .flatMap(jobGroups)
        .filter((group) => group.configs.includes(configPath("cli-process")));
      const processKeys = combinedProcessGroups.flatMap((group) =>
        group.timing_key ? [group.timing_key] : [],
      );
      expect(processKeys).toHaveLength(combinedProcessGroups.length);
      expect(new Set(processKeys).size).toBe(processKeys.length);
      // Each child still fits its 150s limit, but two no longer fit a 250s bin.
      timings.mockReturnValue(Object.fromEntries(processKeys.map((key) => [key, 160])));
      const overBudget = bundleTests(options);
      expectEvery(
        overBudget,
        (job) =>
          job.groups.filter((group) => processKeys.includes(group.timing_key ?? "")).length <= 1,
      );
      // A truthful oversized child must remain alone even beside a tiny CLI.
      timings.mockReturnValue({
        "agentic-cli": 3,
        ...Object.fromEntries(processKeys.map((key) => [key, 200])),
      });
      const oversized = bundleTests(options).filter((job) =>
        job.groups.some((group) => processKeys.includes(group.timing_key ?? "")),
      );
      expect(oversized).toHaveLength(processKeys.length);
      expectEvery(oversized, (job) => job.groups.length === 1);

      // Cheaper complete CLI children can share below 150s. A later unrelated
      // non-dist owner must not invalidate that earlier sibling exemption.
      const processFiles = ["src/cli/help-exit.process.test.ts", "src/cli/one-shot-exit.test.ts"];
      cliProcessTestFiles.splice(0, cliProcessTestFiles.length, ...processFiles);
      const smallerConfigs = new Set([configPath("cli-process"), configPath("tooling-isolated")]);
      restore();
      useFixtureProjects((config) => smallerConfigs.has(config));
      timings.mockImplementation((profile) => ({
        "agentic-cli-process": profile === "github" ? 200 : 120,
        "core-tooling-isolated": 20,
      }));
      const cheaper = bundleTests(options);
      const cliJob = cheaper.find((job) =>
        job.groups.some((group) => group.configs.includes(configPath("cli-process"))),
      )!;
      expect(cliJob.groups).toHaveLength(2);
      expectSameEntries(cliJob.groups.flatMap(optionalPatterns), processFiles);
      const unrelated = findGroupJob(cheaper, "core-tooling-isolated")!;
      expect(unrelated).toMatchObject({ runner: cliJob.runner, requiresDist: false });
      expect(unrelated.groups).toHaveLength(1);
      expect(unrelated.pretestBuildMode).toBeUndefined();
      expect(cliJob.predictedSeconds! + unrelated.predictedSeconds!).toBeLessThanOrEqual(150);
    } finally {
      restore();
      cliProcessTestFiles.splice(0, cliProcessTestFiles.length, ...originalProcessFiles);
    }
  });

  it("keeps full locale finalizer proof in manual plans and fast locale contracts in PR plans", () => {
    const proof = "test/scripts/control-ui-locale-finalizer.test.ts";
    const fast = "test/scripts/control-ui-locale-refresh.test.ts";
    const direct = buildVitestRunPlans([proof]);
    expect(direct).toHaveLength(1);
    expect([...(direct[0]?.forwardedArgs ?? []), ...(direct[0]?.includePatterns ?? [])]).toContain(
      proof,
    );
    const owners = (plan: ReturnType<typeof planTests>, file: string) => {
      const rawConfig = required(buildVitestRunPlans([file])[0]?.config);
      const config = resolveCanonicalNodeTestConfig(file, rawConfig) ?? rawConfig;
      return plan.filter(
        (shard) =>
          shard.configs.includes(config) &&
          (!shard.includePatterns ||
            shard.includePatterns.some((pattern) => matchesGlob(file, pattern))),
      );
    };
    expect(owners(defaultShards, proof)).toHaveLength(1);
    const pr = planTests({ compactMode: "pull-request", changedPaths: [proof, fast] });
    expect(owners(pr, proof)).toHaveLength(0);
    expect(owners(pr, fast)).toHaveLength(1);
    const selected = required(selectTests([proof, fast], { runnerBackend: "github" }));
    expect(planFiles(selected)).toEqual([fast]);
  });

  it("retains recovery contracts in their main, PR, and manual Node tiers", () => {
    const proofFiles = ["src/gateway/server.codex-failure-recovery.test.ts"];
    const files = (mode: "push" | "pull-request") => planFiles(committedPlan(mode));
    const mainFiles = files("push");
    const prFiles = files("pull-request");
    const manual = planTests({ includeProofTests: false });
    for (const file of proofFiles) {
      expect(mainFiles.filter((target) => target === file)).toHaveLength(1);
      expect(prFiles.filter((target) => target === file)).toHaveLength(1);
      const rawConfig = required(buildVitestRunPlans([file])[0]?.config);
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
    const isolated = required(
      manual.find((shard) => shard.shardName === "agentic-gateway-server-isolated"),
    );
    expect(isolated.configs).toContain(configPath("gateway-server-isolated"));
    expect(
      isolated.includePatterns ?? listMatchedTestFiles(createGatewayServerIsolatedVitestConfig({})),
    ).toContain("src/gateway/server.chat-recovered-output.test.ts");
  });

  it("defers exactly the runtime release inventory from automatic plans on github", () => {
    const runnerBackend = "github";

    const reducedOwners = defaultShards
      .filter(
        (shard) =>
          shard.shardName === "core-runtime-config" ||
          shard.shardName === "agentic-cli" ||
          shard.includePatterns?.some(isReleaseOnlyRuntimeTestFile),
      )
      .map((shard) => shard.shardName);
    for (const compactMode of ["push", "pull-request"] as const) {
      const before = committedPlan(compactMode, runnerBackend);
      const after = bundleTests({
        compactMode,
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyRuntimeTests: false,
        changedPaths: ["src/config/state-startup-corpus.test-support.ts"],
      });
      expectRuntimeReleaseInventory({ before, after, reducedOwners, compactMode });
    }
  });

  it("keeps noncompact reduced runtime bundles separate from release timing history", () => {
    const full = bundleTests();
    const reduced = bundleTests({ includeReleaseOnlyRuntimeTests: false });
    for (const config of [
      configPath("runtime-config"),
      configPath("infra"),
      configPath("unit-src"),
    ]) {
      expectNone(
        full.filter((shard) => shard.configs.includes(config)),
        (shard) => shard.timing_key,
      );
      const owners = reduced.filter((shard) => shard.configs.includes(config) && shard.timing_key);
      expect(owners.length, config).toBeGreaterThan(0);
      for (const owner of owners) {
        const key = required(owner.timing_key);
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
      .flatMap(optionalPatterns)
      .filter((file) => !isCiProofTestFile(file))
      .slice(0, 102);
    expect(selected).toHaveLength(102);
    vi.spyOn(testTimings, "readToolingFileTimings").mockReturnValue({});
    vi.spyOn(shardMetadata, "estimateVitestToolingFileSeconds").mockReturnValue(20_000);
    // Every selected file is now indivisible above the admission cap. Overflow
    // must retain these 102 files without adding unrelated dist owners or the full suite.
    expect(() => selectTests(selected, { runnerBackend: "github" })).toThrow(
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
      const shard = required(defaultShards.find((entry) => entry.shardName === owner));
      const target =
        owner === "agentic-cli"
          ? "src/cli/nodes-cli.coverage.test.ts"
          : required(
              shard.includePatterns?.find((file) =>
                file.startsWith("packages/gateway-client/src/"),
              ),
            );
      const plan = required(selectTests([target], { runnerBackend }));
      const groups = plan.flatMap(jobGroups);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.configs).toEqual([
        owner === "agentic-cli" ? configPath("cli") : configPath("gateway-client"),
      ]);
      if (owner === "agentic-cli") {
        expect(groups[0]!.shard_name).toMatch(/^agentic-cli(?:-hosted-\d+)?$/u);
      }
      expectFields(groups[0], {
        includePatterns: [target],
        fallbackMaxWorkers: runnerBackend === "github" ? undefined : 2,
        env: runnerBackend === "github" ? { OPENCLAW_VITEST_MAX_WORKERS: "2" } : undefined,
      });
      expect(plan.map((job) => job.planConcurrency)).toEqual([1]);
      if (runnerBackend !== "github") {
        expect(plan.map((job) => job.runner)).toEqual(["blacksmith-16vcpu-ubuntu-2404"]);
      }
      if (owner === "agentic-gateway-core-2") {
        const changed = required(changedTests([target], { runnerBackend }));
        expect(changed.flatMap((job) => job.targets ?? [])).not.toContain(target);
        const changedOwner = required(findFileJob(changed, target));
        expectFields(changedOwner, { groups, planConcurrency: 1 });
      }
    },
  );

  it.each([
    ["blacksmith", "src/gateway/board-store.test.ts", "blacksmith-16vcpu-ubuntu-2404"],
    ["hybrid", "src/gateway/board-store.test.ts", "blacksmith-16vcpu-ubuntu-2404"],
    ["hybrid", "src/gateway/board-http.test.ts", "blacksmith-32vcpu-ubuntu-2404"],
  ])(
    "preserves qualified database selection capacity on %s for %s",
    (runnerBackend, target, runner) => {
      const plan = required(selectTests([target], { runnerBackend }));
      const selectedJob = only(plan);
      expect(selectedJob).toMatchObject({ runner, planConcurrency: 1, requiresDist: false });
      expect(selectedJob.groups).toHaveLength(1);
      expect(selectedJob.groups[0]).toMatchObject({
        configs: [configPath("gateway-database-workers")],
        includePatterns: [target],
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        fallbackMaxWorkers: 2,
        minTotalMemoryBytes: 28 * 1024 ** 3,
      });
    },
  );

  it("shares one prepared runtime across affordable github groups", () => {
    const runnerBackend = "github";

    const targets = [
      PRIVATE_QA_TOOLING_TEST,
      "src/infra/update-candidate-canary.integration.test.ts",
    ];
    spyTimings().mockReturnValue(
      Object.fromEntries(defaultShards.map((shard) => [shard.shardName, 1])),
    );
    const plan = selectTests(targets, { runnerBackend });
    expect(plan).not.toBeNull();
    const readers = plan!.filter((shard) => !shard.requiresDist);
    const reader = only(readers);
    expect(reader).toMatchObject({ pretestBuildMode: "private-qa", planConcurrency: 1 });
    expect(reader.predictedSeconds).toBeLessThanOrEqual(210);
    expectEvery(reader.groups, (group) => group.pretestBuildMode);
    expectSameEntries(reader.groups.flatMap(optionalPatterns), targets);
  });

  it("retains indivisible-file costs when canonical measurements are stale-low", () => {
    const target = "src/cli/local-state-owner.process.test.ts";
    spyTimings().mockReturnValue(
      Object.fromEntries(defaultShards.map((shard) => [shard.shardName, 1])),
    );
    vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockImplementation((file) =>
      file === target ? 200 : 3,
    );
    const plan = required(selectTests([target], { runnerBackend: "hybrid" }));
    expect(planFiles(plan)).toEqual([target]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.predictedTestSeconds).toBeGreaterThanOrEqual(200);
  });

  it("allocates sparse selections without reserving their full-suite rows", async () => {
    const heavyCli = "src/cli/gateway-backed-exit-health.process.test.ts";
    const targets = [
      "src/config/allowed-values.test.ts",
      "src/commands/doctor-heartbeat-cadence-migration.test.ts",
      "src/infra/heartbeat-events.test.ts",
      "src/infra/runtime-guard.test.ts",
      heavyCli,
      "src/cli/directory-cli.test.ts",
      "src/config/config.backup-rotation.test.ts",
      "src/config/commands.test.ts",
    ];
    const configs = {
      infra: configPath("infra"),
      config: configPath("runtime-config"),
      commands: configPath("commands"),
      cli: configPath("cli-process"),
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
      ...fillers("src/infra/heartbeat"),
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
      "core-runtime-infra-heartbeat-core": 170,
      "core-runtime-infra-system-runtime": 160,
      "core-runtime-infra-misc-os": 170,
      "core-runtime-infra-provider-push": 160,
      "core-runtime-infra-channel-plugin": 150,
      "core-runtime-infra-diagnostics-state": 150,
      "agentic-cli-process": 240,
      "agentic-commands-doctor-sessions-cron": 120,
    };
    vi.resetModules();
    mockPlanShards(() => [
      fixtureShard("core-runtime", [configs.infra, configs.config]),
      fixtureShard("agentic", [configs.commands, configs.cli]),
    ]);
    mockOriginal("database", {
      databaseWorkerCoreTestFiles: [],
      isDatabaseWorkerCoreTestFile: () => false,
    });
    mockTrackedFiles((root: string) => inventory.filter((file) => file.startsWith(`${root}/`)));
    mockOriginal("inventory", {
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
    });
    mockPlanTimings(() => timings);
    const {
      createNodeTestShardBundles: createBundles,
      createSelectedNodeTestShardBundles: createSelected,
    } = await loadPlanModule(["inventory", "database"]);

    const options = {
      runnerBackend: "hybrid",
      includeReleaseOnlyRuntimeTests: false,
    } satisfies NonNullable<Parameters<typeof createSelected>[1]>;
    let full = createBundles({
      ...options,
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request",
    });
    const heavyGroup = required(
      full.flatMap(jobGroups).find((group) => group.includePatterns?.includes(heavyCli)),
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
    expectPlanFiles(selected, targets);
    expectEvery(selected, (job) => job.groups.every((group) => group.includePatterns!.length > 0));
    expect(sumSeconds(selected)).toBeLessThan(sumSeconds(owners));
    const heavyJob = findFileJob(selected, heavyCli)!;
    expect(heavyJob.predictedSeconds).toBeGreaterThan(150);
    expect(heavyJob.groups.flatMap(optionalPatterns)).toEqual([heavyCli]);
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
        const original = findGroupJob(full, group.shard_name)!;
        expect(job).toMatchObject({
          runner: original.runner,
          planConcurrency: original.planConcurrency,
          requiresDist: original.requiresDist,
        });
        expectInherited(job, original, "pretestBuildMode", "timeoutMinutes", "env");
        const owner = original.groups.find((entry) => entry.shard_name === group.shard_name)!;
        expectInherited(group, owner, "env", "fallbackMaxWorkers", "minTotalMemoryBytes");
      }
    }
  });

  it("serializes a selected singleton without expanding its worker allowance", async () => {
    const target = "src/gateway/client-callsites.guard.test.ts";
    const config = configPath("gateway-client");
    const infraConfig = configPath("infra");
    const gatewayFiles = [
      "src/gateway/client.fixture-a.test.ts",
      target,
      "src/gateway/client.fixture-b.test.ts",
    ];
    const infraFiles = ["src/infra/env.test.ts"];
    vi.resetModules();
    mockPlanShards(() => [
      fixtureShard("core-runtime", [infraConfig]),
      fixtureShard("agentic", [config]),
    ]);
    mockTrackedFiles((root: string) =>
      root === "src/gateway"
        ? gatewayFiles
        : root === "src/infra"
          ? infraFiles
          : root === "." || root === "src"
            ? [...gatewayFiles, ...infraFiles]
            : [],
    );
    mockOriginal("timings", {
      readCompactGroupTimings: () => ({
        "agentic-gateway-core-1": 128,
        "agentic-gateway-core-2": 128,
        "agentic-gateway-core-3": 128,
        "core-runtime-infra-env-auth": 128,
      }),
      readRuntimePlacementTimings: () => [],
    });
    mockOriginal("metadata", { estimateVitestTestFileSeconds: () => 3 });
    mockUnbuiltRuntime();
    const {
      createSelectedNodeTestShardBundles: createSelected,
      createNodeTestShardBundles: createBundles,
    } = await loadPlanModule(["build", "metadata"]);

    const options = {
      runnerBackend: "hybrid",
      includeReleaseOnlyPluginShards: false,
      includeProofTests: false,
      changedPaths: [target],
    };
    const full = createBundles({ ...options, compactMode: "pull-request" });
    const original = required(findFileJob(full, target));
    expect(original.planConcurrency).toBe(2);
    expect(original.groups).toHaveLength(2);
    const owner = required(
      original.groups.find((group) => group.includePatterns?.includes(target)),
    );
    expect(owner.fallbackMaxWorkers).toBe(2);
    expect(workers(owner)).toBeUndefined();
    const selected = required(createSelected([target], options));
    const selectedJob = only(selected);
    expect(selectedJob).toMatchObject({
      runner: "blacksmith-16vcpu-ubuntu-2404",
      planConcurrency: 1,
      requiresDist: false,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    });
    expect(selectedJob.groups).toHaveLength(1);
    expect(selectedJob.groups[0]).toMatchObject({
      configs: [config],
      includePatterns: [target],
      fallbackMaxWorkers: 2,
    });
    expectInherited(selectedJob.groups[0], owner, "env", "minTotalMemoryBytes");
    expectFields(selectedJob, {
      pretestBuildMode: original.pretestBuildMode,
      timeoutMinutes: original.timeoutMinutes, // Retain the existing conservative rounding of the canonical group price.
      predictedSeconds: 129,
      predictedTestSeconds: 129,
    });
  });

  it.each(["blacksmith", "hybrid"])(
    "retains parallel capacity and ordered wall budgets for selected %s files",
    async (runnerBackend) => {
      const config = configPath("infra");
      const entries = [
        ["src/infra/env.test.ts", "core-runtime-infra-env-auth", 170],
        ["src/infra/os-summary.test.ts", "core-runtime-infra-misc-os", 170],
        ["src/infra/ports-probe.test.ts", "core-runtime-infra-system-runtime", 160],
        ["src/infra/provider-usage.load.test.ts", "core-runtime-infra-provider-push", 160],
        ["src/infra/channel-runtime-context.test.ts", "core-runtime-infra-channel-plugin", 150],
        ["src/infra/diagnostic-trace-context.test.ts", "core-runtime-infra-diagnostics-state", 150],
      ] as const;
      const files = entries.map(([file]) => file);
      const targets = files.slice(0, 3);
      vi.resetModules();
      mockPlanShards(() => [fixtureShard("core-runtime", [config])]);
      mockOriginal("database", {
        databaseWorkerCoreTestFiles: [],
        isDatabaseWorkerCoreTestFile: () => false,
      });
      mockTrackedFiles((root: string) => (root === "src/infra" ? files : []));
      mockPlanTimings(() =>
        Object.fromEntries(entries.map(([, owner, seconds]) => [owner, seconds])),
      );
      mockUnbuiltRuntime();
      const {
        createSelectedNodeTestShardBundles: createSelected,
        createNodeTestShardBundles: createBundles,
      } = await loadPlanModule(["build", "database"]);

      const full = createBundles({
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
        includeProofTests: false,
        changedPaths: targets,
        compactMode: "pull-request",
      });
      const selected = required(createSelected(targets, { runnerBackend }));
      // The selected 170/170/160 envelopes fit the aggregate limit but need 330 seconds together.
      expect(selected).toHaveLength(2);
      expect(selected.map((job) => job.groups.length).toSorted((a, b) => a - b)).toEqual([1, 2]);
      expect(
        selected.map((job) => job.planConcurrency).toSorted((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual([1, 2]);
      for (const job of selected) {
        expect(job.runner).toBe("blacksmith-32vcpu-ubuntu-2404");
        for (const group of job.groups) {
          const original = required(findGroupJob(full, group.shard_name));
          const owner = required(
            original.groups.find((entry) => entry.shard_name === group.shard_name),
          );
          expectFields(job, {
            planConcurrency: job.groups.length === 1 ? 1 : original.planConcurrency,
            env: job.groups.length === 1 ? { OPENCLAW_VITEST_MAX_WORKERS: "2" } : original.env,
          });
          expectInherited(group, owner, "env", "fallbackMaxWorkers");
        }
      }
      expectEvery(selected, (job) => job.predictedTestSeconds! <= 300);
      expect(selected.map((job) => job.predictedTestSeconds!).toSorted((a, b) => a - b)).toEqual([
        160, 170,
      ]);
      expect(sumSeconds(selected)).toBe(500);
      expectPlanFiles(selected, targets, requiredPatterns);
    },
  );

  async function createToolingFixturePlan(params: {
    files: string[];
    shards: typeof fullSuiteVitestShards;
    timings: Record<string, number>;
    fileTimings?: Readonly<Record<string, number>>;
    fileSeconds: (file: string) => number;
    options: {
      compactMode: "push" | "pull-request";
      runnerBackend?: string;
      includeReleaseOnlyPluginShards: false;
      compactNodeJobCap?: number;
    };
  }) {
    mockPlanShards(() => params.shards);
    await mockFastPaths();
    mockFixture("timings", () => ({
      ...testTimings,
      readCompactGroupTimings: () => params.timings,
      ...(params.fileTimings ? { readToolingFileTimings: () => params.fileTimings! } : {}),
    }));
    mockFixture("metadata", () => ({
      ...shardMetadata,
      estimateVitestToolingFileSeconds: params.fileSeconds,
    }));
    mockTrackedFiles((rootDir: string) => (rootDir === "test" ? params.files.toSorted() : []));
    return await withPlanModule(
      ({ createNodeTestShardBundles: createPlan }) => {
        // These fixtures exercise a caller's 90-row reservation independently
        // of the profile ceiling; explicit tighter reservations remain authoritative.
        return createPlan({
          ...params.options,
          compactNodeJobCap: params.options.compactNodeJobCap ?? 90,
        });
      },
      ["metadata", "fast"],
    );
  }

  it.each([undefined, "blacksmith"])(
    "preserves compiler/artifact capacity (%s)",
    async (runnerBackend) => {
      const ordinary = Array.from(
        { length: 64 },
        (_, index) => `test/scripts/tooling-capacity-${String(index).padStart(2, "0")}.test.ts`,
      );
      const longFiles = new Set(ordinary.slice(0, 16));
      const protectedFiles = [
        "test/scripts/vitest-worker-artifacts.ci.test.ts",
        "test/scripts/write-unified-entry-dts.test.ts",
        "test/scripts/write-plugin-sdk-entry-dts.test.ts",
      ];
      const files = [...ordinary, ...protectedFiles];
      const jobs = await createToolingFixturePlan({
        files,
        shards: [
          fixtureShard("core-tooling", [configPath("tooling")], configPath("full-core-tooling")),
        ],
        timings: {},
        fileTimings: {},
        fileSeconds: (file) => (longFiles.has(file) ? 125 : 50),
        options: {
          compactMode: "pull-request",
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
        },
      });
      expectPlanFiles(jobs, files);
      expect(new Set(planFiles(jobs)).size).toBe(files.length);
      expect(jobs.some((job) => job.runner === "blacksmith-16vcpu-ubuntu-2404")).toBe(true);
      for (const job of jobs) {
        const needsCapacity = planFiles([job]).some((file) => protectedFiles.includes(file));
        expectFields(job, {
          runner: needsCapacity ? EXTRA_LARGE_NODE_TEST_RUNNER : "blacksmith-16vcpu-ubuntu-2404",
          planConcurrency: 1,
        });
        expectEvery(job.groups, (group) => workers(group) === "2");
      }
    },
  );

  it("exchanges hosted anchors before opening another pull-request job", async () => {
    const compactMode = "pull-request" as const;

    const anchors = [126, 105, 63, 42, 42, 42].map((seconds, index) => ({
      name: `exchange-anchor-${index}`,
      seconds,
    }));
    const shards = anchors.map(({ name }) =>
      fixtureShard(name, [`test/vitest/vitest.${name}.config.ts`]),
    );
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
    expect(sortedGroups(plan)).toEqual(
      shards.map(({ name, projects }) => ({
        shard_name: name,
        configs: projects,
        requiresDist: false,
        runner: BUNDLED_NODE_TEST_RUNNER,
      })),
    );
    for (const job of plan) {
      expect(job).toMatchObject({ predictedSeconds: 210, planConcurrency: 1 });
      expect(job.groups.length).toBeLessThanOrEqual(10);
    }
  });

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
          fixtureShard("core-tooling", [configPath("tooling")], configPath("full-core-tooling")),
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
      expectPlanFiles(plan, files);
      expectEvery(
        plan,
        (job) => job.planConcurrency === 1 && job.groups.every((group) => workers(group) === "2"),
      );
      // Setup is separate from the sum of the test-step packing prices.
      expect(sumSeconds(plan)).toBe(expectedSeconds);
      expect(findFileJob(plan, whale)?.predictedSeconds).toBeGreaterThanOrEqual(whaleSeconds);
      const whaleOnly = await createToolingFixturePlan({ ...params, files: [whale] });
      expect(
        whaleOnly
          .filter((job) => job.groups.some((group) => group.includePatterns?.includes(whale)))
          .map((job) => job.predictedSeconds),
      ).toEqual([whaleSeconds]);
      expect(sumSeconds(whaleOnly)).toBe(whaleSeconds);
      for (const group of plan.flatMap(jobGroups)) {
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
        fixtureShard("core-tooling", [configPath("tooling")], configPath("full-core-tooling")),
      ],
      timings: {},
      fileSeconds: (file) => fileSeconds.get(file)!,
      options: compactOptions("github", "pull-request"),
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
    expectEvery(
      job.groups,
      (group) =>
        group.pretestBuildMode === undefined &&
        /^core-tooling-\d+-hosted-\d+$/u.test(group.shard_name),
    );
    expect(
      new Set(job.groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, ""))).size,
    ).toBe(2);
    expectSameEntries(job.groups.flatMap(optionalPatterns), [compiler, ...shortFiles]);
    expectPlanFiles(plan, files);
  });

  it("keeps hosted tooling within the GitHub job cap when its inventory grows", async () => {
    // Seventy-eight full-budget anchors leave 12 of the 90 jobs for tooling.
    const anchors = Array.from({ length: 78 }, (_, index) =>
      fixtureShard(`capacity-anchor-${index}`, [
        `test/vitest/vitest.capacity-anchor-${index}.config.ts`,
      ]),
    );
    const fixtureShards = [
      ...anchors,
      fixtureShard("core-tooling", [configPath("tooling")], configPath("full-core-tooling")),
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
    const options = compactOptions("github", "pull-request");
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
      .flatMap(jobGroups)
      .filter(isNumberedToolingGroup)
      .flatMap(optionalPatterns);
    expect(baseline).toHaveLength(90);
    expectSameEntries(baselineToolingFiles, fixtureFiles);
    const grown = await createPlanWithInventory(true);
    const toolingGroups = grown.flatMap(jobGroups).filter(isNumberedToolingGroup);
    const toolingFiles = toolingGroups.flatMap(optionalPatterns);

    expect(grown.length).toBeLessThanOrEqual(90);
    expect(new Set(toolingFiles).size).toBe(toolingFiles.length);
    expectSameEntries(toolingFiles, [...baselineToolingFiles, inventoryGrowthFile]);
    expect(nonToolingPlacement(grown)).toEqual(nonToolingPlacement(baseline));

    const budgeted = await createPlanWithInventory(true, 89);
    expect(budgeted.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(89);
    expect(nonToolingPlacement(budgeted)).toEqual(nonToolingPlacement(grown));
    expectSameEntries(
      budgeted.flatMap(jobGroups).filter(isNumberedToolingGroup).flatMap(optionalPatterns),
      toolingFiles,
    );

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
      expect(job).toMatchObject({ requiresDist: false, planConcurrency: 1 });
      expect(job.groups.length).toBeLessThanOrEqual(10);
      if (job.groups.length > 1) {
        expect(job.predictedSeconds).toBeLessThanOrEqual(
          job.pretestBuildMode ? 210 : job.groups.every(isHostedToolingGroup) ? 300 : 150,
        );
        if (job.pretestBuildMode) {
          expectEvery(job.groups, (group) => group.pretestBuildMode);
        }
      }
      expect(job.runner).toBe(job.groups[0]?.runner);
      expectEvery(
        hostedToolingGroups,
        (group) => (runnerRanks.get(job.runner) ?? -1) >= (runnerRanks.get(group.runner) ?? 0),
      );
      if (hostedToolingGroups.some((group) => group.runner !== job.runner)) {
        expectEvery(job.groups, isHostedToolingGroup);
        expect(job.pretestBuildMode).toBeUndefined();
        expectEvery(job.groups, (group) => group.pretestBuildMode === undefined);
      }
    }
  });

  it("retains Gateway database consumers in the canonical worker plan", () => {
    const worker = createGatewayDatabaseWorkersVitestConfig({});
    const core = createGatewayCoreVitestConfig({});
    const server = createGatewayServerVitestConfig({});
    const methods = createGatewayMethodsVitestConfig({});
    expect(worker.test).toMatchObject({ pool: "forks", fileParallelism: true, isolate: false });
    expect(core.test?.isolate).toBe(true);
    expect(methods.test).toMatchObject({ pool: "forks", isolate: false });
    for (const previous of [core, server, methods]) {
      expectInherited(worker.test, previous.test, "runner", "setupFiles");
    }
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
    expect(
      defaultShards.filter((shard) =>
        shard.configs.includes(configPath("gateway-database-workers")),
      ),
    ).toHaveLength(1);
  });

  it("retains host-owned database consumers in the canonical infra plan", () => {
    const infra = createInfraVitestConfig({});
    expect(infra.test?.setupFiles).toEqual(createAgentsSupportVitestConfig({}).test?.setupFiles);
    const admitted = new Set(listMatchedTestFiles(infra));
    for (const file of [
      "src/agents/embedded-agent-runner/run.session-permissions.test.ts",
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
    const gatewayWorkerFiles = databaseWorkerCoreTestFiles.filter((file) =>
      file.startsWith("src/gateway/"),
    );
    const gatewayPlanFiles = defaultShards
      .filter((shard) => shard.shardName.startsWith("agentic-gateway-core"))
      .flatMap(optionalPatterns);
    expect(gatewayPlanFiles.filter((file) => gatewayWorkerFiles.includes(file))).toEqual([]);
    const infraPlanFiles = defaultShards
      .filter((shard) => shard.configs.includes(configPath("infra")))
      .flatMap(optionalPatterns);
    expectSameEntries(
      infraPlanFiles.filter((file) => gatewayWorkerFiles.includes(file)),
      gatewayWorkerFiles,
    );
    const selected = [
      "src/plugin-state/plugin-state-store.test.ts",
      "test/plugins/beam-http-identity.test.ts",
    ];
    const includeFile = join(tempDirs.make("database-worker-routing-"), "include.json");
    writeFileSync(includeFile, JSON.stringify(selected));
    expectSameEntries(
      listMatchedTestFiles(createInfraVitestConfig({ OPENCLAW_VITEST_INCLUDE_FILE: includeFile })),
      selected,
    );
  });

  it("prices parallel cron from serial work until github has direct measurements", () => {
    const runnerBackend = "github";

    useFixtureProjects((config) => config === configPath("cron"));

    const timings = spyTimings().mockReturnValue({
      "core-runtime-cron-core": 40,
      "core-runtime-cron-isolated-agent": 100,
      "core-runtime-cron-service": 140,
    });
    const options = { compactMode: "pull-request" as const, runnerBackend };
    const baseline = bundleTests(options);
    const totalSeconds = (plan: typeof baseline) => sumSeconds(plan);
    expect(totalSeconds(baseline)).toBe(140);
    expect(baseline.flatMap(jobGroups)).toHaveLength(3);
    timings.mockReturnValue({
      "core-runtime-cron-core": 400,
      "core-runtime-cron-isolated-agent": 1_000,
      "core-runtime-cron-service": 1_400,
      "core-runtime-cron-parallel-core": 20,
      "core-runtime-cron-parallel-isolated-agent": 60,
      "core-runtime-cron-parallel-service": 80,
    });
    const measured = bundleTests(options);
    expect(totalSeconds(measured)).toBe(160);
    const groups = measured.flatMap(jobGroups);
    expect(groups).toHaveLength(3);
    expectEvery(
      groups,
      (group) => group.env === undefined && group.fallbackMaxWorkers === undefined,
    );
    expectSameEntries(groups.flatMap(optionalPatterns), planFiles(baseline));
  });

  it("keeps the changed Gateway catalog runtime build on hybrid", () => {
    const file = "test/plugins/codex-model-catalog.gateway.test.ts";
    const shards = changedTests([file], { runnerBackend: "hybrid" });
    const owners = (shards ?? []).flatMap((shard) =>
      (shard.groups ?? []).flatMap((group) =>
        (group.includePatterns ?? [])
          .filter((selected) => selected === file)
          .map(() => ({ shard, group })),
      ),
    );
    const owner = only(owners);
    expectFields(owner.group, {
      includePatterns: [file],
      configs: [configPath("gateway-database-workers")],
      pretestBuildMode: "runtime",
    });
    expectFields(owner.shard, { planConcurrency: 1, pretestBuildMode: "runtime" });
  });

  it("keeps the complete tooling family in manual plans and omits it from product plans", () => {
    const automatic = planTests({ includeReleaseOnlyToolingShards: false });
    const hasTooling = (shards: typeof automatic) =>
      shards.some((shard) => shard.shardName.startsWith("core-tooling-"));
    expect(hasTooling(defaultShards)).toBe(true);
    expect(hasTooling(automatic)).toBe(false);
    const files = automatic.flatMap(optionalPatterns);
    expectNone(files, (file) => file.startsWith("test/scripts/"));
    expect(files).toContain("src/infra/home-dir.test.ts");
  });

  it.each([
    RELEASE_REPORT_OWNER_TEST,
    "scripts/lib/vitest-report-owner.mts",
    "src/scripts/example.ts",
    "config/ci-budget.md",
    configPath("tooling"),
    "package.json",
    "patches/vitest@5.0.5.patch",
    ".github/workflows/ci.yml",
    "apps/ios/fastlane/Fastfile",
    "extensions/matrix/scripts/build.mjs",
  ])("retains the complete tooling family when owner %s changes", (changedPath) => {
    expect(
      planTests({
        includeReleaseOnlyToolingShards: false,
        changedPaths: ["src/plugin-sdk/core.ts", changedPath],
      }),
    ).toEqual(defaultShards);
  });

  it("preserves product coverage and canonical tooling owners across the github release tier", () => {
    const runnerBackend = "github";

    const options = compactOptions(runnerBackend, "pull-request");
    const full = committedPlan("pull-request", runnerBackend);
    const automatic = bundleTests({
      ...options,
      includeReleaseOnlyToolingShards: false,
      changedPaths: ["src/gateway/server.ts"],
    });
    const fullGroups = full.flatMap(jobGroups);
    const automaticGroups = automatic.flatMap(jobGroups);
    const productFiles = (groups: typeof fullGroups) =>
      groups
        .filter((group) => !group.configs.some((config) => config.includes("vitest.tooling")))
        .flatMap(
          (group) =>
            group.includePatterns ??
            group.configs.flatMap((config) => {
              if (config === configPath("unit-fast-isolated")) {
                return getUnitFastIsolatedTestFiles();
              }
              if (config === configPath("unit-fast-fake-timers")) {
                return getUnitFastTimerTestFiles();
              }
              return [];
            }),
        )
        .filter((file) => !file.startsWith("test/scripts/") && !file.startsWith("src/scripts/"))
        .toSorted();
    expectNone(automaticGroups, (group) =>
      group.configs.some((config) => config.includes("vitest.tooling")),
    );
    expectNone(automaticGroups.flatMap(optionalPatterns), (file) =>
      file.startsWith("test/scripts/"),
    );
    expect(productFiles(automaticGroups)).toEqual(productFiles(fullGroups));
    expect(
      bundleTests({
        ...options,
        includeReleaseOnlyToolingShards: false,
        changedPaths: ["package.json"],
      }),
    ).toEqual(full);
    const push = bundleTests({
      ...options,
      compactMode: "push",
      includeReleaseOnlyToolingShards: false,
      changedPaths: ["package.json"],
    });
    expectNone(push.flatMap(jobGroups), (group) =>
      group.configs.some((config) => config.includes("vitest.tooling")),
    );
    expectNone(planFiles(push), (file) => file.startsWith("test/scripts/"));
  });

  it("keeps changed native browser tests in UI jobs", () => {
    const target = "extensions/workboard/browser/catalog.test.ts";
    const shards = changedTests([target]);
    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.targets ?? shard.includePatterns ?? [])).toContain(
      target,
    );
  });

  it("prepares the provider runtime for selected extension target extensions/telegram/src/bot.create-telegram-bot.native-pipeline.test.ts", () => {
    const target = "extensions/telegram/src/bot.create-telegram-bot.native-pipeline.test.ts";

    const owners = (changedTests([target]) ?? []).filter((shard) =>
      (shard.groups ?? [shard]).some((group) => group.includePatterns?.includes(target)),
    );

    expect(owners).toHaveLength(1);
    expect(owners[0]?.pretestBuildMode).toBe("runtime");
  });

  it("retains the changed host plugin test in a bounded hub plan beside store aliases", () => {
    const target = "src/plugins/tools.optional.test.ts";
    const changedPaths = [...STORE_ALIAS_CHANGED_PATHS, "tsconfig.json"];
    const onFallback = vi.fn();
    const changedShards = changedTests(changedPaths, { onFallback });
    expect(changedShards).not.toBeNull();
    expect(onFallback).not.toHaveBeenCalled();
    expect(
      changedShards?.flatMap((shard) =>
        (shard.targets ?? []).concat((shard.groups ?? [shard]).flatMap(optionalPatterns)),
      ),
    ).toContain(target);
    const options = { changedPaths, includeReleaseOnlyPluginShards: false };
    const shards = planTests(options);
    expect(shards.filter((shard) => shard.shardName === "agentic-plugins")).toEqual([
      {
        checkName: "checks-node-agentic-plugins",
        shardName: "agentic-plugins",
        configs: [configPath("plugins")],
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
    const shards = planTests(options);
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
    ).toEqual([[configPath("infra")]]);
    expect(shards.filter((shard) => shard.shardName !== "agentic-plugins")).toEqual(
      planTests({ includeReleaseOnlyPluginShards: false }),
    );
    expect(planTests({ ...options, includeReleaseOnlyPluginShards: true })).toEqual(defaultShards);
  });

  it("does not widen plugin coverage for deleted tests, sources, docs, or directories", () => {
    const deletedTest = "src/plugins/deleted-ci-routing.test.ts";
    expect(existsSync(deletedTest)).toBe(false);
    const options = {
      includeReleaseOnlyPluginShards: false,
      changedPaths: [deletedTest, "src/plugins/tools.ts", "src/plugins", "docs/ci.md"],
    };
    expect(planTests(options)).toEqual(planTests({ includeReleaseOnlyPluginShards: false }));
  });
  it.each([
    {
      owner: "infra",
      prefix: "core-runtime-infra-",
      config: configPath("infra"),
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
        .flatMap(optionalPatterns)
        .toSorted((a, b) => a.localeCompare(b));

      expect(actual).toEqual(expectedFiles().toSorted((a, b) => a.localeCompare(b)));
      expect(new Set(actual).size).toBe(actual.length);
    },
  );

  it("covers every executable auto-reply reply test exactly once across split shards", () => {
    const actual = defaultShards
      .filter((shard) => shard.shardName.startsWith("auto-reply-reply-"))
      .flatMap(optionalPatterns)
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listMatchedTestFiles(createAutoReplyReplyVitestConfig({})));
    expect(new Set(actual).size).toBe(actual.length);
  });
});

function expectImpacts(
  classify: (paths: string[]) => boolean,
  cases: readonly (readonly [string, boolean])[],
) {
  for (const [file, expected] of cases) {
    expect(classify([file]), file).toBe(expected);
  }
}

describe("CI changed Node test plan", () => {
  it.each([
    ["ui/src/main.ts", true],
    ["ui/src/pages/chat/chat-gateway.test.ts", false],
    // Erased TSX header imports do not bring Gateway server code into the UI runtime.
    ["packages/gateway-client/src/index.ts", false],
    ["packages/gateway-client/src/browser.ts", true],
  ] as const)("selects UI performance for %s: %s", (file, expected) => {
    expect(hasControlUiPerformanceAffectingChange([file])).toBe(expected);
  });

  it("classifies prompt-snapshot impact by surface and generator import graph", () => {
    expectImpacts(hasPromptSnapshotAffectingChange, [
      // Inside the generator's import graph -> regenerated output can change.
      ["src/auto-reply/reply/prompt-prelude.ts", true],
      // The codex extension loads through a dynamic bundled-plugin module id the
      // graph walk cannot see; it stays on the always-run surface.
      ["extensions/codex/src/index.ts", true],
      ["test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/README.md", true],
      ["scripts/generate-prompt-snapshots.ts", true],
      // Workspace packages feed the generator through package-specifier imports
      // the relative graph walk cannot see.
      ["packages/llm-core/src/index.ts", true],
      // The gate's own orchestration must not be able to skip the gated lane.
      [".github/workflows/ci.yml", true],
      ["scripts/lib/ci-changed-node-test-plan.mts", true],
      // Outside the surface and the generator graph -> the lane may skip.
      ["ui/src/app.ts", false],
      ["extensions/discord/src/index.ts", false],
      ["docs/index.md", false],
      ["test/scripts/ci-node-test-plan.test.ts", false],
      // Deleted source files cannot be graphed; fail safe to running the check.
      ["src/infra/definitely-deleted-module.ts", true],
    ]);
  });

  it("classifies SQLite session lifecycle impact by owner and import graph", () => {
    expectImpacts(hasSqliteSessionLifecycleAffectingChange, [
      ["src/agents/embedded-agent-runner/run/attempt-session-runtime-prepare.ts", true],
      ["src/gateway/server-methods/sessions.ts", true],
      ["src/sessions/session-lifecycle-admission.ts", true],
      ["src/config/sessions.ts", true],
      ["test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts", true],
      ["packages/media-understanding-common/src/provider-id.ts", false],
      ["src/agents/model-auth.ts", false],
      ["extensions/discord/src/index.ts", false],
      ["src/config/sessions/session-registry-maintenance.test.ts", false],
      ["src/infra/definitely-deleted-module.ts", false],
      ["src/agents/embedded-agent-runner/run/deleted-session-runtime.ts", true],
    ]);
  });

  it("keeps compact packing policy and runtime inputs bounded", () => {
    const onFallback = vi.fn();
    changedOwnerTests(
      ["scripts/lib/ci-node-test-plan.mts", "test/scripts/ci-node-test-plan.test.ts"],
      { runnerBackend: "blacksmith", onFallback },
    );
    expect(onFallback).not.toHaveBeenCalledWith("compact packing policy requires full-plan proof");
    const globalPlan = changedOwnerTests(["scripts/run-vitest.mts"], {
      onFallback,
    });
    expect(globalPlan).not.toBeNull();
    expect(selectedFiles(globalPlan)).toContain("test/scripts/test-projects.test.ts");
    expect(selectedFiles(globalPlan)).not.toContain("src/cron/service.stream-trigger.test.ts");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("keeps measured packing ownership bounded on RunsOn", () => {
    const shards = changedOwnerTests(["scripts/lib/ci-measured-compact-packing.mts"], {
      runnerBackend: "runson",
    });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("test/scripts/ci-node-test-plan.test.ts");
    expect(selectedFiles(shards)).not.toContain("src/cron/service.stream-trigger.test.ts");
  });

  it("fails safe for raw Git paths that resemble normalized script paths", () => {
    for (const changedPath of [
      " scripts/changed-lanes.mts",
      String.raw`scripts\changed-lanes.mts`,
    ]) {
      expect(changedOwnerTests([changedPath]), changedPath).toBeNull();
    }
  });

  it("keeps the complete budgeted corpus plan beside a documentation page", () => {
    const targets = startupCorpusTestFiles;
    const before = changedOwnerTests(targets);
    expect(before).toHaveLength(4);
    expect(selectedFiles(before)).toContain(lintSuppressionInventoryTest);
    const corpusShards =
      before?.filter((shard) => !selectedFiles([shard]).includes(lintSuppressionInventoryTest)) ??
      [];
    expect(corpusShards).toHaveLength(3);
    expect(corpusShards.every((shard) => (shard.predictedSeconds ?? 0) <= 150)).toBe(true);
    expect(corpusShards.flatMap((shard) => shard.targets ?? []).toSorted()).toEqual(
      targets.toSorted(),
    );
    expect(corpusShards.some((shard) => shard.pretestBuildMode === "runtime")).toBe(true);
    expect(changedOwnerTests([...targets, "docs/ci/pipeline.md"])).toEqual(before);
  });

  it("retains the mapped prompt Markdown owner beside documentation", () => {
    const fixture =
      "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md";
    const before = changedOwnerTests([fixture]);
    expect(before).not.toBeNull();
    const ownedTargets = before?.flatMap((shard) => [
      ...(shard.targets ?? []),
      ...(shard.includePatterns ?? []),
      ...(shard.groups?.flatMap(optionalPatterns) ?? []),
    ]);
    expect(ownedTargets).toContain("test/scripts/prompt-snapshots.test.ts");
    expect(changedOwnerTests([fixture, "docs/ci/pipeline.md"])).toEqual(before);
  });
});
