import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { estimateCommandWorkerSeconds as estimateWorkers } from "../../scripts/lib/ci-command-test-plan.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import {
  createCompactSplitTimingGeneration as splitGeneration,
  parseCompactSplitTimingKey as parseSplitKey,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createCommandsVitestConfig } from "../vitest/vitest.commands.config.ts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import { listMatchedTestFiles } from "./ci-node-test-plan.test-support.js";

const commandsConfig = "test/vitest/vitest.commands.config.ts";
const defaultRunner = "blacksmith-8vcpu-ubuntu-2404";
type FileInventory = typeof import("../../scripts/lib/list-test-files.mts");
type ShardInventory = typeof import("../vitest/vitest.test-shards.mjs");
type FastInventory = typeof import("../vitest/vitest.unit-fast-paths.mjs");
type BuildPrerequisites = typeof import("../../scripts/lib/vitest-build-prerequisites.mts");
const planOptions = { compactMode: "pull-request" as const, includeReleaseOnlyPluginShards: false };
const commandFile = (name: string) => `src/commands/${name}.test.ts`;
const fixtureShard = (name = "agentic", config = commandsConfig) => ({
  name,
  config: "fixture.config.ts",
  projects: [config],
});
const hosted = (owner: string) => (group: CompactNodeTestShard["groups"][number]) =>
  group.shard_name.startsWith(`${owner}-hosted-`);
const jobFor = (jobs: CompactNodeTestShard[], owner: string) =>
  jobs.find((job) => job.groups.some((group) => group.shard_name === owner))!;
const includedFiles = (groups: CompactNodeTestShard["groups"]) =>
  groups.flatMap((group) => group.includePatterns!).toSorted();
const sole = <T>(items: T[]): T => {
  expect(items).toHaveLength(1);
  return items[0]!;
};
afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const commandGroups = (job: CompactNodeTestShard) =>
  job.groups.filter((group) => group.configs.includes(commandsConfig));
const ownerName = (name: string) => name.replace(/-hosted-\d+$/u, "");
function mockHost(cpus = 8, gib = 31) {
  vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
  vi.spyOn(os, "totalmem").mockReturnValue(gib * 1024 ** 3);
}
function workerEnv(job: CompactNodeTestShard, workers = 8): NodeJS.ProcessEnv {
  return {
    CI: "true",
    RUNNER_ENVIRONMENT: "self-hosted",
    OPENCLAW_VITEST_MAX_WORKERS: String(workers),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(job.planConcurrency),
    OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(job.env ?? {}),
  };
}

async function observeCommandWorkers(job: CompactNodeTestShard, env: NodeJS.ProcessEnv = {}) {
  const seen = new Map<string, string | undefined>();
  const result = await runShardPlans(
    resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(job.groups) }),
    {
      env: { ...workerEnv(job), ...env },
      scratchDir: tempDirs.make("command-worker-plan-"),
      runChild: async (_args, childEnv, label) => {
        seen.set(label, childEnv.OPENCLAW_VITEST_MAX_WORKERS);
        return 0;
      },
    },
  );
  expect(result).toBe(0);
  return seen;
}

async function withCommandInventory(
  files: string[],
  shards: typeof fullSuiteVitestShards,
  timings: typeof testTimings.readCompactGroupTimings,
  run: (planner: typeof import("../../scripts/lib/ci-node-test-plan.mts")) => Promise<void>,
) {
  vi.resetModules();
  const mocks: string[] = [];
  function mock<T extends object>(path: string, overrides: Partial<T>) {
    mocks.push(path);
    vi.doMock(path, async (original) => ({ ...(await original<T>()), ...overrides }));
  }
  mock<FileInventory>("../../scripts/lib/list-test-files.mts", {
    listTrackedTestFiles: (root) => (root === "src/commands" ? files : []),
  });
  mock<ShardInventory>("../vitest/vitest.test-shards.mjs", {
    fullSuiteVitestShards: shards,
  });
  const empty = () => [];
  mock<FastInventory>("../vitest/vitest.unit-fast-paths.mjs", {
    getUnitFastTestFiles: empty,
    getUnitFastIsolatedTestFiles: empty,
    getUnitFastTimerTestFiles: empty,
    getUnitFastTestFilesForIncludePatterns: empty,
  });
  mock<typeof testTimings>("../../scripts/lib/ci-test-timings.mts", {
    readCompactGroupTimings: timings,
    readRuntimePlacementTimings: empty,
  });
  mock<BuildPrerequisites>("../../scripts/lib/vitest-build-prerequisites.mts", {
    resolveVitestPretestBuildMode: () => undefined,
  });
  try {
    await run(await import("../../scripts/lib/ci-node-test-plan.mts"));
  } finally {
    for (const path of mocks) {
      vi.doUnmock(path);
    }
    vi.resetModules();
  }
}

it.each(["hybrid", "blacksmith", "github"])(
  "delivers %s allocations through the shard executor",
  async (runnerBackend) => {
    const plan = createNodeTestShardBundles({ ...planOptions, runnerBackend });
    let measuredGroups = 0;
    let fallbackGroups = 0;
    for (const job of plan) {
      const commands = commandGroups(job);
      if (!commands.length) {
        continue;
      }
      const roomy = job.runner === "blacksmith-32vcpu-ubuntu-2404";
      mockHost(roomy ? 8 : 2, roomy ? 31 : 8);
      const jobWorkers =
        runnerBackend !== "github" &&
        roomy &&
        job.planConcurrency === 1 &&
        job.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined
          ? 8
          : 2;
      const seen = await observeCommandWorkers(job, {
        RUNNER_ENVIRONMENT: runnerBackend === "github" ? "github-hosted" : "self-hosted",
      });
      for (const group of commands) {
        const expected = Math.min(
          jobWorkers,
          Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? jobWorkers),
        );
        expect(seen.get(group.shard_name), group.shard_name).toBe(String(expected));
        expect(group.timing_key).toContain(`#file-parallel-${expected}`);
        if (expected === 8) {
          measuredGroups += 1;
        } else {
          fallbackGroups += 1;
        }
      }
    }
    expect(fallbackGroups).toBeGreaterThan(0);
    expect(measuredGroups > 0).toBe(runnerBackend !== "github");
  },
);

it.each(["blacksmith", "hybrid"])(
  "scales %s work with file and direct-sample floors",
  (runnerBackend) => {
    const group = {
      configs: [commandsConfig],
      includePatterns: Array.from({ length: 12 }, (_, i) => commandFile(`fixture-${i}`)),
      timing_key: "fixture#file-parallel-2",
    };
    const observations = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    const estimate = (files = group.includePatterns, seconds = 120) =>
      estimateWorkers({ ...group, includePatterns: files }, seconds, 8, runnerBackend);
    expect(estimate()).toEqual({ timingKey: "fixture#file-parallel-8", seconds: 30 });
    expect(estimate(group.includePatterns.slice(0, 3)).seconds).toBe(80);
    expect(estimate([commandFile("doctor-config-preflight.refusal.process")], 194.3).seconds).toBe(
      194.3,
    );
    observations.mockReturnValue({ "fixture#file-parallel-8": 45 });
    expect(estimate().seconds).toBe(45);
  },
);

it("refits precise command selections independently by worker policy and retains exact prices", async () => {
  const owner = "agentic-commands-doctor-auth";
  const files = ["hints", "profile-health", "shared-health"].map((part) =>
    commandFile(`doctor-auth.${part}`),
  );
  const targets = files.slice(0, 2);
  const companion = fixtureShard("ordinary", "test/vitest/vitest.hooks.config.ts");
  const timings: Record<string, number> = { [owner]: 120, ordinary: 50 };
  await withCommandInventory(
    files,
    [fixtureShard(), companion],
    () => timings,
    async ({ createSelectedNodeTestShardBundles: createSelected }) => {
      const create = () => createSelected(targets, { runnerBackend: "blacksmith" })!;
      const logs: CiTimingRun["logs"] = [];
      const cells = [
        { workers: 2, config: "test/vitest/vitest.hooks.config.ts", seconds: 240 },
        { workers: 8, config: "test/vitest/vitest.gateway-core.config.ts", seconds: 180 },
      ].map((cell) => {
        companion.projects = [cell.config];
        const job = sole(create());
        const group = sole(job.groups);
        expect(group).toMatchObject({ includePatterns: targets, configs: [commandsConfig] });
        expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
        expect(job.planConcurrency).toBe(cell.workers === 2 ? 2 : 1);
        return Object.assign({}, cell, { job, group });
      });
      mockHost();
      for (const { workers, job, group, seconds } of cells) {
        const env = { ...workerEnv(job, workers), FROZEN_TARGET: "false" };
        const seen = await observeCommandWorkers(job, env);
        expect(seen.get(group.shard_name)).toBe(String(workers));
        expect.soft(group.timing_key).toContain(`#file-parallel-${workers}#selector-`);
        logs.push({
          kind: "compact",
          labels: ["blacksmith-32vcpu-ubuntu-2404"],
          text: [
            ...Object.entries(env).map(([key, value]) => `2026-09-27T00:00:00Z ${key}: ${value}`),
            `2026-09-27T00:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups(job.groups)}`,
            `2026-09-27T00:00:00Z [shard:resources] logicalCpuCount=8 totalMemoryBytes=${31 * 1024 ** 3} requested plans=${job.planConcurrency} admitted plans=1`,
            `2026-09-27T00:00:00Z [shard:${group.timing_key}] begin`,
            `${new Date(Date.parse("2026-09-27T00:00:00Z") + seconds * 1000).toISOString()} [shard:${group.timing_key}] end (exit 0)`,
          ].join("\n"),
        });
      }
      expect.soft(cells[0]!.group.timing_key).not.toBe(cells[1]!.group.timing_key);
      const result = refitTestTimings(
        [1, 2].map((id) => ({
          id,
          createdAt: `2026-09-${25 + id}T00:00:00Z`,
          completeInventory: false,
          pullRequestMergeRef: true,
          logs,
        })),
      );
      expect(result.rejectedWorkerKeys.blacksmith).toEqual([]);
      for (const { config: companionConfig, group, job, seconds } of cells) {
        const key = group.timing_key!;
        expect(result.timings.compactGroupSeconds.blacksmith[key]).toBe(seconds);
        companion.projects = [companionConfig];
        timings[key] = 1;
        expect(create()[0]!.predictedTestSeconds).toBe(job.predictedTestSeconds);
        timings[key] = seconds;
        expect(create()[0]).toEqual(
          expect.objectContaining({
            predictedTestSeconds: seconds,
            predictedSeconds: seconds,
            planConcurrency: job.planConcurrency,
            groups: job.groups,
          }),
        );
      }
    },
  );
});

it("projects serial timings once, retaining complete history and indivisible files", async () => {
  const owner = "agentic-commands-agent-channel";
  const memoryOwner = "agentic-commands-doctor-sessions-cron-memory";
  const timingKey = `${owner}#file-parallel-2`;
  const files = ["agent-one", "agent-two"].map(commandFile);
  const memoryFile = commandFile("doctor-session-sqlite.memory");
  const legacy = { [owner]: 200, [memoryOwner]: 1000 };
  let observations: ReturnType<typeof testTimings.readCompactGroupTimings> = legacy;
  const fixtureShards = [fixtureShard()];
  await withCommandInventory(
    [...files, memoryFile],
    fixtureShards,
    () => observations,
    async ({ createNodeTestShardBundles: createPlan }) => {
      const create = () => createPlan({ ...planOptions, runnerBackend: "blacksmith" });
      const totalSeconds = (jobs: ReturnType<typeof create>) =>
        jobs.reduce((sum, job) => sum + job.predictedSeconds!, 0);
      const projected = create();
      const projectedGroup = jobFor(projected, owner).groups.find((g) => g.shard_name === owner)!;
      expect(projectedGroup).toMatchObject({ timing_key: timingKey, fallbackMaxWorkers: 2 });
      expect(projectedGroup.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
      expect(jobFor(projected, memoryOwner)).toMatchObject({
        predictedSeconds: 1000,
        groups: [{ includePatterns: [memoryFile] }],
      });
      expect(totalSeconds(projected)).toBe(1100);

      observations = { ...legacy, [timingKey]: 200 };
      expect(totalSeconds(create())).toBe(1200);
      const generation = splitGeneration({
        configs: [commandsConfig],
        parentShardName: owner,
        stripes: files.map((file) => [file]),
      });
      observations = { ...legacy, [generation.timingKeys[0]!]: 500 };
      expect(totalSeconds(create())).toBe(1100);
      observations = { ...observations, [generation.timingKeys[1]!]: 500 };
      const retained = create();
      expect(totalSeconds(retained)).toBe(2000);
      const groupsFor = (jobs: CompactNodeTestShard[]) =>
        jobs.flatMap((job) => job.groups.filter(hosted(owner)));
      const retainedGroups = groupsFor(retained);
      expect(includedFiles(retainedGroups)).toEqual(files);
      expect(
        retainedGroups.every((g) => parseSplitKey(g.timing_key!)?.parentShardName === timingKey),
      ).toBe(true);

      const gatewayOwner = "agentic-gateway-server-isolated";
      fixtureShards.push({
        ...fixtureShard(gatewayOwner, "test/vitest/vitest.gateway-server-isolated.config.ts"),
        config: "fixture-gateway.config.ts",
      });
      observations = {
        [owner]: 200,
        [timingKey]: 100,
        [memoryOwner]: 1000,
        [gatewayOwner]: 80,
      };
      expect(jobFor(create(), owner).groups.some((g) => g.shard_name === gatewayOwner)).toBe(true);
      const priorObservations = observations;
      const parallelGeneration = splitGeneration({
        configs: [commandsConfig],
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        parentShardName: timingKey,
        stripes: [files],
      });
      observations = { ...observations, [parallelGeneration.timingKeys[0]!]: 200 };
      const measured = create();
      const measuredJobs = measured.filter((job) => job.groups.some(hosted(owner)));
      const measuredGroups = groupsFor(measuredJobs);
      expect(includedFiles(measuredGroups)).toEqual(files);
      expect(measuredGroups).toHaveLength(2);
      expect(
        measuredJobs.some(
          (job) => job.runner === "blacksmith-32vcpu-ubuntu-2404" && job.planConcurrency === 1,
        ),
      ).toBe(true);
      expect(totalSeconds(measured)).toBe(1280);
      mockHost();
      for (const job of measuredJobs) {
        const seen = await observeCommandWorkers(job);
        for (const group of job.groups.filter((entry) => measuredGroups.includes(entry))) {
          expect(seen.get(group.shard_name)).toBe("2");
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
          expect(group.timing_key).toContain("#file-parallel-2#selector-");
        }
      }
      observations = { ...priorObservations, [`${owner}#file-parallel-8`]: 250 };
      const commandJob = jobFor(create(), owner);
      // Reserve the worker-specific sample before deciding whether rows can share.
      expect(commandJob.groups).toHaveLength(1);
      expect(commandJob.groups[0]?.includePatterns?.toSorted()).toEqual(files.toSorted());
      expect(commandJob.predictedTestSeconds).toBeLessThanOrEqual(300);
    },
  );
});
it("keeps Doctor session SQLite owners complete and isolated", () => {
  const placementsFor = (plan: CompactNodeTestShard[], owners: string[]) =>
    plan.flatMap((job, jobIndex) =>
      job.groups
        .filter((group) => owners.includes(ownerName(group.shard_name)))
        .map((group) => Object.assign({}, group, { jobIndex })),
    );
  const ownerPrefix = "agentic-commands-doctor-sessions-cron";
  const ownerNames = ["", "-memory", "-sqlite", "-sqlite-recovery"].map((s) => ownerPrefix + s);
  const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
  const commandShards = base.filter((shard) => shard.configs.includes(commandsConfig));
  const owners = new Map(
    commandShards
      .filter((shard) => ownerNames.includes(shard.shardName))
      .map((shard) => [shard.shardName, shard.includePatterns]),
  );
  expect(owners.get(`${ownerPrefix}-memory`)).toEqual([
    commandFile("doctor-session-sqlite.memory"),
  ]);
  for (const [owner, representative] of [
    ["-sqlite", "doctor-session-sqlite"],
    ["-sqlite-recovery", "doctor-session-sqlite.receipt-recovery"],
    ["", "doctor-session-sqlite.shared-store"],
  ]) {
    expect(owners.get(ownerPrefix + owner)).toContain(commandFile(representative!));
  }
  const commandFiles = commandShards.flatMap((shard) => shard.includePatterns ?? []).toSorted();
  expect(commandFiles).toEqual(listMatchedTestFiles(createCommandsVitestConfig({})));
  expect(new Set(commandFiles).size).toBe(commandFiles.length);

  for (const compactMode of ["push", "pull-request"] as const) {
    const plan = createNodeTestShardBundles({
      ...planOptions,
      compactMode,
      runnerBackend: "blacksmith",
    });
    const placements = placementsFor(plan, ownerNames);
    expect(new Set(placements.map((group) => ownerName(group.shard_name)))).toEqual(
      new Set(ownerNames),
    );
    expect(new Set(placements.map(({ jobIndex }) => jobIndex)).size).toBe(placements.length);
    expect(placements.every((group) => group.runner === defaultRunner)).toBe(true);
  }

  const families = [ownerNames, [1, 2, 3].map((part) => `agentic-gateway-core-${part}`)];
  const fixtureConfigs = new Set(
    base
      .filter((shard) => families.some((family) => family.includes(shard.shardName)))
      .flatMap((shard) => shard.configs),
  );
  const originalShards = fullSuiteVitestShards.slice();
  const fixtureShards = originalShards
    .map((shard) => ({ ...shard, projects: shard.projects.filter((c) => fixtureConfigs.has(c)) }))
    .filter((shard) => shard.projects.length > 0);
  fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
  try {
    // Affordable descendants must also stay apart from their unsplit ancestors'
    // siblings: an immediate-selector-only rule loses the Doctor/giant boundary.
    const fixtureTimings = Object.fromEntries(
      base
        .filter((shard) => shard.configs.some((config) => fixtureConfigs.has(config)))
        .map((shard) => [shard.shardName, 1]),
    );
    vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
      ...fixtureTimings,
      ...Object.fromEntries(
        families.flatMap((family) =>
          family.map((name, i) => [name, i ? 10 : profile === "github" ? 400 : 100]),
        ),
      ),
    }));
    const nestedPlan = createNodeTestShardBundles({ ...planOptions, runnerBackend: "hybrid" });
    for (const family of families) {
      const placements = placementsFor(nestedPlan, family);
      expect(placements.filter(hosted(family[0]!))).toHaveLength(
        family[0]!.startsWith("agentic-commands-") ? 2 : 3,
      );
      expect(new Set(placements.map(({ jobIndex }) => jobIndex)).size, family[0]).toBe(
        placements.length,
      );
      for (const name of family) {
        const actual = placements
          .filter((group) => ownerName(group.shard_name) === name)
          .flatMap((group) => group.includePatterns ?? []);
        expect(actual.toSorted(), name).toEqual(
          base.find((shard) => shard.shardName === name)?.includePatterns?.toSorted(),
        );
      }
    }
  } finally {
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
  }
});
