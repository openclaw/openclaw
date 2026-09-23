import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as measuredPacking from "../../scripts/lib/ci-measured-compact-packing.mts";
import { rebalanceMeasuredHybridJobs } from "../../scripts/lib/ci-measured-compact-packing.mts";
import {
  type CompactNodeTestShard,
  createNodeTestShardBundles,
  createNodeTestShards,
} from "../../scripts/lib/ci-node-test-plan.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { createCompactSplitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";

afterEach(() => vi.restoreAllMocks());

describe("measured CI row packing", () => {
  it.each([
    { compactMode: "push" as const, budget: 720, groupCounts: [6], prices: [620] },
    { compactMode: "pull-request" as const, budget: 600, groupCounts: [5, 1], prices: [560, 205] },
  ])(
    "packs $compactMode by two-slot elapsed time within $budget seconds",
    ({ compactMode, budget, groupCounts, prices }) => {
      const entries = Array.from({ length: 6 }, (_, index) => ({
        name: `ordinary-fixture-${index + 1}`,
        config: `fixture-${index + 1}.config.ts`,
        projects: ["test/vitest/vitest.hooks.config.ts"],
      }));
      const seconds = Object.fromEntries(
        entries.map(({ name }, index) => [name, index < 3 ? 225 : 95]),
      );
      vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(seconds);
      vi.spyOn(measuredPacking, "getMeasuredCompactGroupSeconds").mockImplementation(
        (_job, group) => seconds[group.shard_name],
      );
      vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
      const original = fullSuiteVitestShards.slice();
      try {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...entries);
        const options = {
          compactMode,
          runnerBackend: "blacksmith",
          includeReleaseOnlyPluginShards: false,
        };
        const declared = createNodeTestShards(options).map(
          ({ checkName: _checkName, shardName, ...group }) =>
            Object.assign({}, group, {
              runner: BUNDLED_NODE_TEST_RUNNER,
              shard_name: shardName,
            }),
        );
        const jobs = createNodeTestShardBundles(options);
        // Half the 960s aggregate plus setup is 590s, but FIFO slots need 510s + 110s.
        expect(jobs.map((job) => job.predictedSeconds)).toEqual(prices);
        expect(jobs.map((job) => job.groups.length)).toEqual(groupCounts);
        expect(jobs.flatMap((job) => job.groups)).toEqual(declared);
        for (const [index, job] of jobs.entries()) {
          expect(job).toMatchObject({
            runner: EXTRA_LARGE_NODE_TEST_RUNNER,
            planConcurrency: groupCounts[index] === 1 ? 1 : 2,
            requiresDist: false,
            timeoutMinutes: 120,
          });
          expect(job.pretestBuildMode).toBeUndefined();
          expect(job.env).toEqual(
            groupCounts[index] === 1 ? { OPENCLAW_VITEST_MAX_WORKERS: "2" } : undefined,
          );
          expect(job.predictedSeconds).toBeLessThanOrEqual(budget);
        }
        expect(createNodeTestShardBundles(options)).toEqual(jobs);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
      }
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

  const measuredSerialFixture = JSON.parse(
    readFileSync(new URL("./fixtures/ci-serial-compact-jobs.json", import.meta.url), "utf8"),
  ) as { jobs: CompactNodeTestShard[]; largeJob: CompactNodeTestShard };
  const measuredSerialOptions = {
    ...measuredPackingOptions,
    compactMode: "push" as const,
    largeRunner: EXTRA_LARGE_NODE_TEST_RUNNER,
  };

  it.each([
    { compactMode: "push" as const, predictedSeconds: 268 },
    { compactMode: "pull-request" as const, predictedSeconds: 273 },
  ])(
    "packs native serial $compactMode observations with one setup reserve and unchanged children",
    ({ compactMode, predictedSeconds }) => {
      const before = structuredClone(measuredSerialFixture.jobs);
      const after = rebalanceMeasuredHybridJobs(before, { ...measuredSerialOptions, compactMode });
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        runner: DEFAULT_NODE_TEST_RUNNER,
        planConcurrency: 1,
        requiresDist: false,
        predictedSeconds,
      });
      expect(after[0]!.groups).toEqual([
        ...before[1]!.groups,
        ...before[0]!.groups,
        ...before[2]!.groups,
      ]);
      expect(after[0]!.env).toBeUndefined();
      expect(after[0]!.pretestBuildMode).toBeUndefined();
      expect(after[0]!.timeoutMinutes).toBeUndefined();
      expect(before).toEqual(measuredSerialFixture.jobs);
    },
  );

  it.each([
    "selector",
    "minimum memory",
    "fallback workers",
    "child workers",
    "job environment",
    "runner",
    "concurrency",
    "pretest build",
  ] as const)("expires native serial observations after changing %s", (change) => {
    const before = structuredClone(measuredSerialFixture.jobs);
    for (const job of before) {
      const group = job.groups[0]!;
      if (change === "selector") {
        group.includePatterns!.push("src/cli/unmeasured-fixture.test.ts");
      } else if (change === "minimum memory") {
        group.minTotalMemoryBytes = 32 * 1024 ** 3;
      } else if (change === "fallback workers") {
        group.fallbackMaxWorkers = 1;
      } else if (change === "child workers") {
        group.env = { ...group.env, OPENCLAW_VITEST_MAX_WORKERS: "1" };
      } else if (change === "job environment") {
        job.env = { OPENCLAW_VITEST_MAX_WORKERS: "1" };
      } else if (change === "runner") {
        job.runner = EXTRA_LARGE_NODE_TEST_RUNNER;
      } else if (change === "concurrency") {
        job.planConcurrency = 2;
      } else {
        job.pretestBuildMode = "runtime";
        group.pretestBuildMode = "runtime";
      }
    }
    expect(rebalanceMeasuredHybridJobs(before, measuredSerialOptions)).toEqual(before);
  });

  it.each([
    { deadlines: [12, 13, 14], shortest: 12 },
    { deadlines: [120, undefined, 120], shortest: 60 },
  ])(
    "packs native serial children under the shortest existing deadline: $shortest",
    ({ deadlines, shortest }) => {
      const before = structuredClone(measuredSerialFixture.jobs);
      before.forEach((job, index) => {
        job.timeoutMinutes = deadlines[index];
      });
      const after = rebalanceMeasuredHybridJobs(before, measuredSerialOptions);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        timeoutMinutes: shortest,
        runner: DEFAULT_NODE_TEST_RUNNER,
        planConcurrency: 1,
      });
      expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
    },
  );

  it("keeps a partially unmeasured serial row intact", () => {
    const before = structuredClone(measuredSerialFixture.jobs);
    before[0]!.groups.push(...before[1]!.groups);
    before.splice(1, 1);
    before[0]!.groups[1]!.includePatterns!.push("src/cli/unmeasured-fixture.test.ts");
    expect(rebalanceMeasuredHybridJobs(before, measuredSerialOptions)).toEqual([
      before[0],
      { ...before[1], predictedSeconds: 147 },
    ]);
  });

  function unmeasuredSerialJobs(runner = EXTRA_LARGE_NODE_TEST_RUNNER) {
    const jobs = structuredClone(measuredSerialFixture.jobs);
    for (const job of jobs) {
      job.runner = runner;
      job.groups[0]!.includePatterns!.push("src/cli/unmeasured-fixture.test.ts");
    }
    return jobs;
  }

  it.each([
    { compactMode: "push" as const, prices: [325, 540] },
    { compactMode: "pull-request" as const, prices: [325, 540] },
  ])(
    "reserves canonical pricing headroom inside the $compactMode budget",
    ({ compactMode, prices }) => {
      const before = unmeasuredSerialJobs();
      const after = rebalanceMeasuredHybridJobs(before, {
        ...measuredSerialOptions,
        compactMode,
        estimateSerialGroup: () => 170,
      });
      // Three 215s children plus 110s setup exceed both budgets; two share one row.
      expect(after.map((job) => job.predictedSeconds).toSorted((a, b) => a! - b!)).toEqual(prices);
      expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
      expect(
        after.every(
          (job) => job.planConcurrency === 1 && job.runner === EXTRA_LARGE_NODE_TEST_RUNNER,
        ),
      ).toBe(true);
    },
  );

  it("reports an oversized canonical child without changing its execution contract", () => {
    const before = unmeasuredSerialJobs().slice(0, 1);
    const after = rebalanceMeasuredHybridJobs(before, {
      ...measuredSerialOptions,
      estimateSerialGroup: () => 518,
    });
    // 518s receives the existing 25% headroom and admission: 650s + 110s setup.
    expect(after).toEqual([{ ...before[0], predictedSeconds: 760 }]);
  });

  it("redistributes an over-budget serial row without adding jobs or changing child contracts", () => {
    const before = unmeasuredSerialJobs();
    const large = before[0]!.groups[0]!;
    const medium = before[1]!.groups[0]!;
    const small = before[2]!.groups[0]!;
    before[0]!.groups.push(medium);
    before.splice(1, 1);
    const canonicalSeconds = new Map([
      [large.shard_name, 318],
      [medium.shard_name, 198],
      [small.shard_name, 118],
    ]);
    const after = rebalanceMeasuredHybridJobs(before, {
      ...measuredSerialOptions,
      estimateSerialGroup: (group) => canonicalSeconds.get(group.shard_name)!,
    });
    // The original 400s + 250s pair needs 760s; moving the 150s child beside 400s fits.
    expect(after).toEqual([
      { ...before[0], groups: [large, small], predictedSeconds: 660 },
      { ...before[1], groups: [medium], predictedSeconds: 360 },
    ]);
    expect(after.every((job) => job.predictedSeconds! <= 720)).toBe(true);
    expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
  });

  it("does not use canonical fallback for an unmeasured eight-class row", () => {
    const before = unmeasuredSerialJobs(DEFAULT_NODE_TEST_RUNNER);
    const estimateSerialGroup = vi.fn(() => 1);
    expect(
      rebalanceMeasuredHybridJobs(before, { ...measuredSerialOptions, estimateSerialGroup }),
    ).toEqual(before);
    expect(estimateSerialGroup).not.toHaveBeenCalled();
  });

  it("prefers the native large-runner child price over its canonical fallback", () => {
    const native = structuredClone(measuredSerialFixture.largeJob);
    const unmeasured = unmeasuredSerialJobs()[0]!;
    unmeasured.timeoutMinutes = native.timeoutMinutes;
    const before = [native, unmeasured];
    const after = rebalanceMeasuredHybridJobs(before, {
      ...measuredSerialOptions,
      estimateSerialGroup: (group) => (group.shard_name === "agentic-cli" ? 1_000 : 170),
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.predictedSeconds).toBe(585);
    expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
  });

  it("moves only the inherited two-worker cap onto children when sharing a default-capacity row", () => {
    const before = unmeasuredSerialJobs();
    before[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
    before[0]!.groups[0]!.env = { FIXTURE_POLICY: "keep" };
    before[0]!.groups[0]!.fallbackMaxWorkers = 2;
    before[0]!.groups[0]!.minTotalMemoryBytes = 28 * 1024 ** 3;
    before[1]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
    before[1]!.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "1" };
    before[2]!.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "4" };
    const original = structuredClone(before);
    const expected = structuredClone(before);
    expected[0]!.groups[0]!.env = { FIXTURE_POLICY: "keep", OPENCLAW_VITEST_MAX_WORKERS: "2" };
    const after = rebalanceMeasuredHybridJobs(before, {
      ...measuredSerialOptions,
      estimateSerialGroup: () => 10,
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      runner: EXTRA_LARGE_NODE_TEST_RUNNER,
      planConcurrency: 1,
      predictedSeconds: 155,
    });
    expect(after[0]!.env).toBeUndefined();
    expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(expected));
    expect(before).toEqual(original);
  });

  it.each<Record<string, string>>([
    { OPENCLAW_VITEST_MAX_WORKERS: "2", FIXTURE_POLICY: "keep" },
    { OPENCLAW_VITEST_MAX_WORKERS: "3" },
  ])("retains a separate cohort for job environment %j", (env) => {
    const before = unmeasuredSerialJobs().slice(0, 2);
    before[0]!.env = env;
    expect(
      rebalanceMeasuredHybridJobs(before, {
        ...measuredSerialOptions,
        estimateSerialGroup: () => 10,
      }),
    ).toEqual(before.map((job) => Object.assign({}, job, { predictedSeconds: 125 })));
  });

  it.each(["build", "dist", "parallel"] as const)(
    "excludes %s rows from canonical serial packing",
    (kind) => {
      const before = unmeasuredSerialJobs();
      for (const job of before) {
        if (kind === "build") {
          job.pretestBuildMode = "runtime";
          job.groups[0]!.pretestBuildMode = "runtime";
        } else if (kind === "dist") {
          job.requiresDist = true;
          job.groups[0]!.requiresDist = true;
        } else {
          job.planConcurrency = 2;
        }
      }
      const estimateSerialGroup = vi.fn(() => 10);
      expect(
        rebalanceMeasuredHybridJobs(before, { ...measuredSerialOptions, estimateSerialGroup }),
      ).toEqual(before);
      expect(estimateSerialGroup).not.toHaveBeenCalled();
    },
  );

  it("packs the native-wall fixture into five while preserving every child and its supplied prices", () => {
    const before = measuredToolingFixture();
    const after = rebalanceMeasuredHybridJobs(before, measuredPackingOptions);
    expect(after).toHaveLength(5);
    expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
    expect(Math.max(...after.map((job) => job.predictedSeconds!))).toBeLessThanOrEqual(720);
    expect(after.every((job) => job.predictedSeconds! > 360)).toBe(true);
    expect(after.every((job) => job.planConcurrency === 1 && job.timeoutMinutes === 20)).toBe(true);
    expect(after.every((job) => job.env?.OPENCLAW_VITEST_MAX_WORKERS === "2")).toBe(true);
  });

  it("splits the observed CLI pair with its measured wall floors and complete child contracts", () => {
    const before = structuredClone(measuredCompactFixture.cliTailJob);
    const after = rebalanceMeasuredHybridJobs([before], measuredPackingOptions);
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
      expect(job.predictedSeconds).toBeGreaterThanOrEqual(
        measuredCompactFixture.cliChildJobWallSeconds[index]!,
      );
    }
  });

  it.each(measuredCompactFixture.toolingTailJobs)(
    "splits observed tooling pair $shardName without transferring runtime preparation",
    (fixture) => {
      const before = structuredClone(fixture);
      const after = rebalanceMeasuredHybridJobs([before], measuredPackingOptions);
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

  it("expires a serial tail observation when the executed selectors change", () => {
    const before = structuredClone(measuredCompactFixture.cliTailJob);
    before.groups[0]!.includePatterns!.push("src/cli/unmeasured-fixture.test.ts");
    const { timingKeys } = createCompactSplitTimingGeneration({
      parentShardName: "agentic-cli-process",
      configs: before.groups[0]!.configs,
      env: before.groups[0]!.env,
      stripes: before.groups.map((group) => group.includePatterns!),
    });
    before.groups.forEach((group, index) => {
      group.timing_key = timingKeys[index]!;
    });
    expect(rebalanceMeasuredHybridJobs([before], measuredPackingOptions)).toEqual([before]);
  });

  it("retains observations when only a sibling's timing generation changes", () => {
    const before = measuredToolingFixture();
    const renamed = before.map((job) => ({
      ...job,
      groups: job.groups.map((group) => ({
        ...group,
        timing_key: `${group.timing_key ?? group.shard_name}#changed-sibling`,
      })),
    }));
    const after = rebalanceMeasuredHybridJobs(renamed, measuredPackingOptions);
    expect(after.map((job) => job.predictedSeconds)).toEqual(
      rebalanceMeasuredHybridJobs(before, measuredPackingOptions).map(
        (job) => job.predictedSeconds,
      ),
    );
    expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(renamed));
  });

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
      expect(rebalanceMeasuredHybridJobs(before, measuredPackingOptions)).toEqual(before);
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
    expect(rebalanceMeasuredHybridJobs([observed], options)[0]!.predictedSeconds).toBe(386);
    const changed = structuredClone(observed);
    changed.groups[0]!.includePatterns!.push("test/scripts/unmeasured-fixture.test.ts");
    const after = rebalanceMeasuredHybridJobs([changed], options);
    expect(after[0]!.predictedSeconds).toBe(310);
    expect(after[0]!.groups).toEqual(changed.groups);
  });

  it("keeps an observed short pair intact without discounting its canonical packing price", () => {
    const before = measuredToolingFixture()[7]!;
    const after = rebalanceMeasuredHybridJobs([before], {
      ...measuredPackingOptions,
      estimateGroup: (group) => ({
        seconds: group.shard_name === "core-tooling-12-hosted-1" ? 218 : 351,
        complete: true,
      }),
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.groups).toEqual(before.groups);
    expect(after[0]!.predictedSeconds).toBe(679);
  });

  it("splits newly expensive tooling pairs after their historical timing identities expire", () => {
    const before = structuredClone(measuredCompactFixture.toolingTailJobs[1]!);
    before.groups.forEach((group, index) => {
      group.timing_key = `unmeasured-child-${index}`;
      group.includePatterns!.push(`test/scripts/unmeasured-fixture-${index}.test.ts`);
    });
    const after = rebalanceMeasuredHybridJobs([before], {
      ...measuredPackingOptions,
      estimateGroup: () => ({ seconds: 320, complete: true }),
    });
    expect(after).toHaveLength(2);
    expect(after.flatMap((job) => job.groups)).toEqual(before.groups);
    expect(after.map((job) => job.predictedSeconds)).toEqual([430, 430]);
  });

  it("does not pack an unmeasured file using the canonical fallback as a wall observation", () => {
    const before = measuredToolingFixture().slice(0, 2);
    before.forEach((job, index) => {
      job.groups[0]!.includePatterns!.push(`test/scripts/unmeasured-fixture-${index}.test.ts`);
    });
    const estimateGroup = () => ({ seconds: 80, complete: false });
    const after = rebalanceMeasuredHybridJobs(before, { ...measuredPackingOptions, estimateGroup });
    expect(after).toHaveLength(2);
    expect(after.map((job) => job.groups)).toEqual(before.map((job) => job.groups));
    expect(after.map((job) => job.predictedSeconds)).toEqual([316, 314]);
    expect(
      rebalanceMeasuredHybridJobs(before, {
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
    const after = rebalanceMeasuredHybridJobs(before, measuredPackingOptions);
    expect(after).toHaveLength(before.length);
    expect(after.map((job) => ({ groups: job.groups, timeout: job.timeoutMinutes }))).toEqual(
      before.map((job) => ({ groups: job.groups, timeout: job.timeoutMinutes })),
    );
  });

  it.each(["job", "file"] as const)(
    "does not replace a higher %s price with a faster measured tooling wall",
    (source) => {
      const before = measuredToolingFixture();
      if (source === "job") {
        before[0]!.predictedSeconds = 900;
      }
      const after = rebalanceMeasuredHybridJobs(before, {
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
      expect(expensive.predictedSeconds).toBe(1_010);
      expect(sortedMeasuredGroups(after)).toEqual(sortedMeasuredGroups(before));
    },
  );
});
