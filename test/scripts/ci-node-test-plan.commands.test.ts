import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import * as commandTestPlan from "../../scripts/lib/ci-command-test-plan.mts";
import * as measuredCompactPacking from "../../scripts/lib/ci-measured-compact-packing.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
} from "../../scripts/lib/ci-node-test-plan.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import {
  createCompactSplitTimingGeneration,
  parseCompactSplitTimingKey,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createCommandsVitestConfig } from "../vitest/vitest.commands.config.ts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import { listMatchedTestFiles } from "./ci-node-test-plan.test-support.js";

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("command CI ownership and parallel timing", () => {
  it.each(["hybrid", "blacksmith", "github"])(
    "delivers each %s command row's allocation through the shard executor",
    async (runnerBackend) => {
      let retainedAllocationPrices = 0;
      if (runnerBackend === "hybrid") {
        const withoutEightWorkerSamples = (profile: "blacksmith" | "github") =>
          Object.fromEntries(
            Object.entries(testTimings.readCompactGroupTimings(profile)).filter(
              ([key]) => !key.includes("#file-parallel-8"),
            ),
          );
        const timings = {
          blacksmith: withoutEightWorkerSamples("blacksmith"),
          github: withoutEightWorkerSamples("github"),
        };
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation(
          (profile) => timings[profile],
        );
        const repricing = vi.spyOn(commandTestPlan, "estimateCommandWorkerSeconds");
        const rebalance = measuredCompactPacking.rebalanceMeasuredHybridJobs;
        vi.spyOn(measuredCompactPacking, "rebalanceMeasuredHybridJobs").mockImplementation(
          (jobs, options) => {
            const groups = jobs.flatMap((job) => job.groups);
            for (const result of repricing.mock.results) {
              if (
                result.type !== "return" ||
                !result.value.timingKey?.includes("#file-parallel-8") ||
                !parseCompactSplitTimingKey(result.value.timingKey)
              ) {
                continue;
              }
              const group = groups.find((entry) => entry.timing_key === result.value.timingKey);
              expect(group).toBeDefined();
              expect(options.estimateSerialGroup?.(group!), group!.shard_name).toBe(
                result.value.seconds,
              );
              retainedAllocationPrices += 1;
            }
            return rebalance(jobs, options);
          },
        );
      }
      const plan = createNodeTestShardBundles({
        compactMode: "pull-request",
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
      });
      if (runnerBackend === "hybrid") {
        expect(retainedAllocationPrices).toBeGreaterThan(0);
      }
      let measuredGroups = 0;
      let fallbackGroups = 0;
      for (const job of plan) {
        const commands = job.groups.filter((group) =>
          group.configs.includes("test/vitest/vitest.commands.config.ts"),
        );
        if (!commands.length) {
          continue;
        }
        const roomy = job.runner === "blacksmith-32vcpu-ubuntu-2404";
        vi.spyOn(os, "availableParallelism").mockReturnValue(roomy ? 8 : 2);
        vi.spyOn(os, "totalmem").mockReturnValue((roomy ? 31 : 8) * 1024 ** 3);
        const expected =
          runnerBackend !== "github" &&
          roomy &&
          job.planConcurrency === 1 &&
          job.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined
            ? 8
            : 2;
        const seen = new Map<string, string | undefined>();
        const plans = resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(job.groups),
        });
        await expect(
          runShardPlans(plans, {
            env: {
              CI: "true",
              RUNNER_ENVIRONMENT: runnerBackend === "github" ? "github-hosted" : "self-hosted",
              OPENCLAW_VITEST_MAX_WORKERS: "8",
              OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(job.planConcurrency),
              OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(job.env ?? {}),
            },
            scratchDir: tempDirs.make("command-worker-plan-"),
            runChild: async (_args, env, label) => {
              seen.set(label, env.OPENCLAW_VITEST_MAX_WORKERS);
              return 0;
            },
          }),
        ).resolves.toBe(0);
        for (const group of commands) {
          const childWorkers = Math.min(
            expected,
            Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? expected),
          );
          expect(seen.get(group.shard_name), group.shard_name).toBe(String(childWorkers));
          expect(group.timing_key).toContain(`#file-parallel-${childWorkers}`);
          if (childWorkers === 8) {
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

  it("scales command work by usable forks while preserving file and direct-sample floors", () => {
    const group = {
      configs: ["test/vitest/vitest.commands.config.ts"],
      includePatterns: Array.from(
        { length: 12 },
        (_, index) => `src/commands/fixture-${index}.test.ts`,
      ),
      timing_key: "fixture#file-parallel-2",
    };
    const observations = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    expect(commandTestPlan.estimateCommandWorkerSeconds(group, 120, 8, "blacksmith")).toEqual({
      timingKey: "fixture#file-parallel-8",
      seconds: 30,
    });
    expect(
      commandTestPlan.estimateCommandWorkerSeconds(
        { ...group, includePatterns: group.includePatterns.slice(0, 3) },
        120,
        8,
        "blacksmith",
      ).seconds,
    ).toBe(80);
    expect(
      commandTestPlan.estimateCommandWorkerSeconds(
        {
          ...group,
          includePatterns: ["src/commands/doctor-config-preflight.refusal.process.test.ts"],
        },
        194.3,
        8,
        "blacksmith",
      ).seconds,
    ).toBe(194.3);
    observations.mockReturnValue({ "fixture#file-parallel-8": 45 });
    expect(commandTestPlan.estimateCommandWorkerSeconds(group, 120, 8, "blacksmith").seconds).toBe(
      45,
    );
  });

  it("projects serial timings once, retaining complete history and indivisible files", async () => {
    const config = "test/vitest/vitest.commands.config.ts";
    const owner = "agentic-commands-agent-channel";
    const memoryOwner = "agentic-commands-doctor-sessions-cron-memory";
    const timingKey = `${owner}#file-parallel-2`;
    const files = ["src/commands/agent-one.test.ts", "src/commands/agent-two.test.ts"];
    const memoryFile = "src/commands/doctor-session-sqlite.memory.test.ts";
    const legacy = { [owner]: 200, [memoryOwner]: 1000 };
    let observations: ReturnType<typeof testTimings.readCompactGroupTimings> = legacy;
    vi.resetModules();
    vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
      listTrackedTestFiles: (root: string) =>
        root === "src/commands" ? [...files, memoryFile] : [],
    }));
    vi.doMock("../vitest/vitest.test-shards.mjs", () => ({
      fullSuiteVitestShards: [{ name: "agentic", config: "fixture.config.ts", projects: [config] }],
    }));
    vi.doMock("../vitest/vitest.unit-fast-paths.mjs", () => ({
      getUnitFastTestFiles: () => [],
      getUnitFastIsolatedTestFiles: () => [],
      getUnitFastTimerTestFiles: () => [],
      getUnitFastTestFilesForIncludePatterns: () => [],
    }));
    vi.doMock("../../scripts/lib/ci-test-timings.mts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../scripts/lib/ci-test-timings.mts")>()),
      readCompactGroupTimings: () => observations,
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
      const create = () =>
        createPlan({
          compactMode: "pull-request",
          includeReleaseOnlyPluginShards: false,
          runnerBackend: "blacksmith",
        });
      const totalSeconds = (jobs: ReturnType<typeof create>) =>
        jobs.reduce((sum, job) => sum + job.predictedSeconds!, 0);
      const projected = create();
      const projectedGroup = projected
        .flatMap((job) => job.groups)
        .find((group) => group.shard_name === owner)!;
      expect(projectedGroup.timing_key).toBe(timingKey);
      expect(projectedGroup.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
      expect(projectedGroup.fallbackMaxWorkers).toBe(2);
      const memoryJob = projected.find((job) =>
        job.groups.some((group) => group.shard_name === memoryOwner),
      )!;
      expect(memoryJob.groups).toHaveLength(1);
      expect(memoryJob.predictedSeconds).toBe(1000);
      expect(memoryJob.groups[0]!.includePatterns).toEqual([memoryFile]);
      expect(totalSeconds(projected)).toBe(1100);

      observations = { ...legacy, [timingKey]: 200 };
      expect(totalSeconds(create())).toBe(1200);
      const generation = createCompactSplitTimingGeneration({
        configs: [config],
        parentShardName: owner,
        stripes: files.map((file) => [file]),
      });
      observations = { ...legacy, [generation.timingKeys[0]!]: 500 };
      expect(totalSeconds(create())).toBe(1100);
      observations = { ...observations, [generation.timingKeys[1]!]: 500 };
      const retained = create();
      expect(totalSeconds(retained)).toBe(2000);
      const retainedGroups = retained
        .flatMap((job) => job.groups)
        .filter((group) => group.shard_name.startsWith(`${owner}-hosted-`));
      expect(retainedGroups.flatMap((group) => group.includePatterns!).toSorted()).toEqual(files);
      expect(
        retainedGroups.every(
          (group) => parseCompactSplitTimingKey(group.timing_key!)?.parentShardName === timingKey,
        ),
      ).toBe(true);
    } finally {
      vi.doUnmock("../../scripts/lib/list-test-files.mts");
      vi.doUnmock("../vitest/vitest.test-shards.mjs");
      vi.doUnmock("../vitest/vitest.unit-fast-paths.mjs");
      vi.doUnmock("../../scripts/lib/ci-test-timings.mts");
      vi.doUnmock("../../scripts/lib/vitest-build-prerequisites.mts");
      vi.resetModules();
    }
  });
  it("keeps Doctor session SQLite owners complete in separate child processes", () => {
    const ownerNames = [
      "agentic-commands-doctor-sessions-cron",
      "agentic-commands-doctor-sessions-cron-memory",
      "agentic-commands-doctor-sessions-cron-sqlite",
      "agentic-commands-doctor-sessions-cron-sqlite-recovery",
    ];
    const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const commandShards = base.filter((shard) =>
      shard.configs.includes("test/vitest/vitest.commands.config.ts"),
    );
    const owners = new Map(
      commandShards
        .filter((shard) => ownerNames.includes(shard.shardName))
        .map((shard) => [shard.shardName, shard.includePatterns]),
    );
    expect(owners.get("agentic-commands-doctor-sessions-cron-memory")).toEqual([
      "src/commands/doctor-session-sqlite.memory.test.ts",
    ]);
    expect(owners.get("agentic-commands-doctor-sessions-cron-sqlite")).toEqual([
      "src/commands/doctor-session-sqlite.archive-safety.test.ts",
      "src/commands/doctor-session-sqlite.compaction-recovery.test.ts",
      "src/commands/doctor-session-sqlite.compaction.test.ts",
      "src/commands/doctor-session-sqlite.failure-reports.test.ts",
      "src/commands/doctor-session-sqlite.inspection.test.ts",
      "src/commands/doctor-session-sqlite.manifests.test.ts",
      "src/commands/doctor-session-sqlite.publication-recovery.test.ts",
      "src/commands/doctor-session-sqlite.recovery-generations.test.ts",
      "src/commands/doctor-session-sqlite.recovery-shared-owners.test.ts",
      "src/commands/doctor-session-sqlite.recovery.test.ts",
      "src/commands/doctor-session-sqlite.restore-history.test.ts",
      "src/commands/doctor-session-sqlite.restore-paths.test.ts",
      "src/commands/doctor-session-sqlite.restore-publication.test.ts",
      "src/commands/doctor-session-sqlite.retirement-disposal.test.ts",
      "src/commands/doctor-session-sqlite.retirement-mutations.test.ts",
      "src/commands/doctor-session-sqlite.retirement-verification.test.ts",
      "src/commands/doctor-session-sqlite.targets.test.ts",
      "src/commands/doctor-session-sqlite.test.ts",
    ]);
    expect(owners.get("agentic-commands-doctor-sessions-cron-sqlite-recovery")).toEqual([
      "src/commands/doctor-session-sqlite-recovery-inventory.test.ts",
      "src/commands/doctor-session-sqlite.active-settlement.test.ts",
      "src/commands/doctor-session-sqlite.receipt-recovery.test.ts",
      "src/commands/doctor-session-transcripts.missing-index.test.ts",
    ]);
    expect(owners.get("agentic-commands-doctor-sessions-cron")).toEqual([
      "src/commands/doctor-heartbeat-cadence-migration.test.ts",
      "src/commands/doctor-heartbeat-scratch-migration.test.ts",
      "src/commands/doctor-heartbeat-session-target.test.ts",
      "src/commands/doctor-heartbeat-source-archive.test.ts",
      "src/commands/doctor-heartbeat-task-migration.test.ts",
      "src/commands/doctor-session-canonical-keys.memory.test.ts",
      "src/commands/doctor-session-canonical-keys.retention.test.ts",
      "src/commands/doctor-session-delivery-state.test.ts",
      "src/commands/doctor-session-exec-policy.test.ts",
      "src/commands/doctor-session-incognito-key-repair.test.ts",
      "src/commands/doctor-session-snapshots.test.ts",
      "src/commands/doctor-session-sqlite-readers.test.ts",
      "src/commands/doctor-session-sqlite.codex-binding.test.ts",
      "src/commands/doctor-session-sqlite.deferred-plugin.test.ts",
      "src/commands/doctor-session-sqlite.discovery.test.ts",
      "src/commands/doctor-session-sqlite.retained-source-verification.test.ts",
      "src/commands/doctor-session-sqlite.shared-orphan.test.ts",
      "src/commands/doctor-session-sqlite.shared-store.test.ts",
      "src/commands/doctor-session-sqlite.source-conflict-recovery.test.ts",
      "src/commands/doctor-session-state-providers.test.ts",
      "src/commands/doctor-session-title-repair.test.ts",
      "src/commands/doctor-session-transcript-headers.test.ts",
      "src/commands/doctor-session-transcript-labels.test.ts",
      "src/commands/doctor-session-transcripts.incident.test.ts",
      "src/commands/doctor-session-transcripts.sqlite.test.ts",
      "src/commands/doctor-session-transcripts.test.ts",
      "src/commands/doctor-session-worktree-workspace.test.ts",
    ]);
    const commandFiles = commandShards.flatMap((shard) => shard.includePatterns ?? []).toSorted();
    expect(commandFiles).toEqual(listMatchedTestFiles(createCommandsVitestConfig({})));
    expect(new Set(commandFiles).size).toBe(commandFiles.length);

    for (const compactMode of ["push", "pull-request"] as const) {
      const plan = createNodeTestShardBundles({
        compactMode,
        runnerBackend: "blacksmith",
        includeReleaseOnlyPluginShards: false,
      });
      const jobs = ownerNames.map((name) =>
        plan.findIndex((shard) => shard.groups.some((group) => group.shard_name === name)),
      );
      expect(jobs.every((job) => job >= 0)).toBe(true);
      expect(
        plan
          .flatMap((job) => job.groups)
          .filter((group) => ownerNames.includes(group.shard_name))
          .map((group) => group.shard_name)
          .toSorted(),
      ).toEqual(ownerNames.toSorted());
      for (const index of new Set(jobs)) {
        const job = plan[index]!;
        if (
          ownerNames.filter((name) => job.groups.some((group) => group.shard_name === name))
            .length < 2
        ) {
          continue;
        }
        expect(job).toMatchObject({
          runner: "blacksmith-32vcpu-ubuntu-2404",
          planConcurrency: 2,
          requiresDist: false,
        });
        expect(job.pretestBuildMode).toBeUndefined();
        expect(job.predictedSeconds).toBeLessThanOrEqual(compactMode === "push" ? 720 : 600);
        const children = resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(job.groups),
        });
        expect(children.map((child) => child.name)).toEqual(
          job.groups.map((group) => group.shard_name),
        );
      }
      expect(
        plan
          .flatMap((shard) => shard.groups)
          .filter((group) => ownerNames.includes(group.shard_name))
          .every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER),
      ).toBe(true);
    }

    const families = [ownerNames, [1, 2, 3].map((part) => `agentic-gateway-core-${part}`)];
    const fixtureConfigs = new Set(
      base
        .filter((shard) => families.some((family) => family.includes(shard.shardName)))
        .flatMap((shard) => shard.configs),
    );
    const originalShards = fullSuiteVitestShards.slice();
    const fixtureShards = originalShards
      .map((shard) => ({
        ...shard,
        projects: shard.projects.filter((config) => fixtureConfigs.has(config)),
      }))
      .filter((shard) => shard.projects.length > 0);
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
    try {
      // Final packing may share a runner; each descendant must retain its own
      // process envelope and complete, disjoint file ownership.
      const fixtureTimings = Object.fromEntries(
        base
          .filter((shard) => shard.configs.some((config) => fixtureConfigs.has(config)))
          .map((shard) => [shard.shardName, 1]),
      );
      vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
        ...fixtureTimings,
        ...Object.fromEntries(
          families.flatMap((family) =>
            family.map((name, index) => [
              name,
              index === 0 ? (profile === "github" ? 400 : 100) : 10,
            ]),
          ),
        ),
      }));
      const nestedPlan = createNodeTestShardBundles({
        compactMode: "pull-request",
        includeReleaseOnlyPluginShards: false,
        runnerBackend: "hybrid",
      });
      for (const family of families) {
        const placements = nestedPlan.flatMap((job, jobIndex) =>
          job.groups
            .filter((group) => family.includes(group.shard_name.replace(/-hosted-\d+$/u, "")))
            .map((group) => ({ group, jobIndex })),
        );
        expect(
          placements.filter(({ group }) => group.shard_name.startsWith(`${family[0]}-hosted-`)),
        ).toHaveLength(family[0]!.startsWith("agentic-commands-") ? 2 : 3);
        for (const jobIndex of new Set(placements.map((entry) => entry.jobIndex))) {
          const job = nestedPlan[jobIndex]!;
          if (placements.filter((entry) => entry.jobIndex === jobIndex).length < 2) {
            continue;
          }
          expect(job.requiresDist).toBe(false);
          expect(job.pretestBuildMode).toBeUndefined();
          expect(job.predictedSeconds).toBeLessThanOrEqual(600);
          expect([1, 2]).toContain(job.planConcurrency);
          if (job.planConcurrency === 2) {
            expect(job.runner).toBe("blacksmith-32vcpu-ubuntu-2404");
          }
          const children = resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(job.groups),
          });
          expect(children.map((child) => child.name)).toEqual(
            job.groups.map((group) => group.shard_name),
          );
        }
        for (const name of family) {
          const actual = placements
            .filter(({ group }) => group.shard_name.replace(/-hosted-\d+$/u, "") === name)
            .flatMap(({ group }) => group.includePatterns ?? []);
          expect(actual.toSorted(), name).toEqual(
            base.find((shard) => shard.shardName === name)?.includePatterns?.toSorted(),
          );
        }
      }
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
    }
  });
});
