import { afterEach, describe, expect, it, vi } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import * as inventory from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  createSelectedNodeTestShardBundles,
  isCanonicalNodeTestConfig,
  nodeTestConfigRequiresCanonicalMetadata,
  resolveCanonicalNodeTestConfig,
  type CompactNodeTestShard,
  type NodeTestShardGroup,
} from "../../scripts/lib/ci-node-test-plan.mts";
import * as timings from "../../scripts/lib/ci-test-timings.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";

vi.mock(import("../../scripts/lib/ci-node-test-plan.mts"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createSelectedNodeTestShardBundles: vi.fn(original.createSelectedNodeTestShardBundles),
    isCanonicalNodeTestConfig: vi.fn(original.isCanonicalNodeTestConfig),
    nodeTestConfigRequiresCanonicalMetadata: vi.fn(
      original.nodeTestConfigRequiresCanonicalMetadata,
    ),
    resolveCanonicalNodeTestConfig: vi.fn(original.resolveCanonicalNodeTestConfig),
  };
});

const config = "test/vitest/vitest.unit.config.ts";
const runner = "blacksmith-8vcpu-ubuntu-2404";

function row(index: number, seconds: number, groups = 1): CompactNodeTestShard {
  return {
    checkName: "checks-node-fixture-" + index,
    shardName: "fixture-" + index,
    runner,
    requiresDist: false,
    planConcurrency: 1,
    predictedSeconds: seconds,
    predictedTestSeconds: seconds,
    timeoutMinutes: 60,
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    groups: Array.from({ length: groups }, (_, part) => ({
      shard_name: "fixture-" + index + "-" + part,
      timing_key: "measured-fixture-" + index + "-" + part,
      configs: [config],
      includePatterns: ["src/infra/packing-" + index + "-" + part + ".test.ts"],
      runner,
      requiresDist: false,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      fallbackMaxWorkers: 2,
      minTotalMemoryBytes: 8 * 1024 ** 3,
    })),
  };
}

function plan(rows: CompactNodeTestShard[], runnerBackend: string, compactNodeJobCap?: number) {
  const targets = rows.flatMap((entry) => entry.groups.flatMap((group) => group.includePatterns!));
  vi.spyOn(testProjects, "buildVitestRunPlans").mockImplementation((files) => [
    {
      config,
      includePatterns: [...files],
      forwardedArgs: [],
      watchMode: false,
    },
  ]);
  vi.mocked(resolveCanonicalNodeTestConfig).mockReturnValue(config);
  vi.mocked(isCanonicalNodeTestConfig).mockReturnValue(true);
  vi.spyOn(inventory, "listNodeTestConfigFiles").mockReturnValue(undefined);
  vi.spyOn(inventory, "listWholeConfigFiles").mockReturnValue(undefined);
  vi.spyOn(inventory, "canSplitWholeConfigGroup").mockReturnValue(false);
  vi.mocked(nodeTestConfigRequiresCanonicalMetadata).mockReturnValue(true);
  vi.mocked(createSelectedNodeTestShardBundles).mockReturnValue(rows);
  vi.spyOn(timings, "readCompactGroupTimings").mockReturnValue({});
  vi.spyOn(timings, "readRepoE2eFileTimings").mockReturnValue(
    Object.fromEntries(
      rows.flatMap((entry) =>
        entry.groups.flatMap((group) =>
          group.includePatterns!.map((file) => [
            file,
            entry.predictedSeconds! / entry.groups.length,
          ]),
        ),
      ),
    ),
  );
  vi.spyOn(timings, "readToolingFileTimings").mockReturnValue({});
  const result = createChangedNodeTestShards(["src/infra/packing-owner.ts"], {
    runnerBackend,
    compactNodeJobCap,
    selectedTestTargets: targets,
    dedicatedBuildArtifacts: true,
  });
  expect(result).not.toBeNull();
  // Boundary guards are unchanged separate workflow owners, not synthetic runtime rows.
  return result!.filter((entry) => entry.groups);
}

function descriptors(groups: NodeTestShardGroup[]) {
  return groups.map((group) => JSON.stringify(group)).toSorted();
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("changed Node row packing", () => {
  it.each(["github", "hybrid"])(
    "packs split-row tails before the PR cap fallback on %s",
    (backend) => {
      const rows = Array.from({ length: 127 }, (_, index) => row(index, 150));
      // Bounding two 225-second rows yields four rows (150 + 75 apiece).
      // Their compatible tails must share a job: 131 rows become exactly 130.
      rows.push(row(127, 225, 3), row(128, 225, 3));
      const before = descriptors(rows.flatMap((entry) => entry.groups));
      const jobs = plan(rows, backend, 130);
      expect(jobs).toHaveLength(130);
      expect(descriptors(jobs.flatMap((entry) => entry.groups!))).toEqual(before);
      expect(new Set(jobs.map((entry) => entry.checkName)).size).toBe(jobs.length);
      expect(jobs.every((entry) => entry.predictedTestSeconds! <= 150)).toBe(true);
      expect(jobs.every((entry) => entry.groups!.length <= 10)).toBe(true);
      for (const job of jobs) {
        expect(job).toMatchObject({
          runner,
          planConcurrency: 1,
          timeoutMinutes: 60,
          env: rows[0]!.env,
        });
        expect(job.requiresDist).toBe(false);
        expect(job.pretestBuildMode).toBeUndefined();
      }
    },
  );

  it.each([75, 76])("never buys capacity by exceeding 150 seconds, tail %s", (tail) => {
    const rows = [
      ...Array.from({ length: 129 }, (_, index) => row(index, 150)),
      row(129, 75),
      row(130, tail),
    ];
    const jobs = plan(rows, "github");
    expect(jobs).toHaveLength(tail === 75 ? 130 : 131);
    expect(descriptors(jobs.flatMap((entry) => entry.groups!))).toEqual(
      descriptors(rows.flatMap((entry) => entry.groups)),
    );
    expect(jobs.every((entry) => entry.predictedTestSeconds! <= 150)).toBe(true);
  });

  it("shares exclusive owners only within their existing serial budget", () => {
    const rows = [row(0, 75), row(1, 75), row(2, 1)];
    rows[0]!.groups[0]!.shard_name = "core-tooling-1";
    rows[1]!.groups[0]!.shard_name = "core-tooling-2";
    const jobs = plan(rows, "github");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.groups).toEqual([...rows[0]!.groups, ...rows[1]!.groups]);
    expect(jobs[0]).toMatchObject({ planConcurrency: 1, predictedTestSeconds: 150 });
    expect(jobs[1]?.groups).toEqual(rows[2]!.groups);
  });

  it.each([5, 6])("retains the ten-group ceiling with %s tail groups", (groups) => {
    const rows = [row(0, 50, 5), row(1, 50, groups)];
    rows[1]!.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "4" };
    const before = descriptors(rows.flatMap((entry) => entry.groups));
    const jobs = plan(rows, "github");
    expect(jobs).toHaveLength(groups === 5 ? 1 : 2);
    expect(descriptors(jobs.flatMap((entry) => entry.groups!))).toEqual(before);
    expect(jobs.every((entry) => entry.groups!.length <= 10)).toBe(true);
  });

  it.each([
    "runner",
    "concurrency",
    "env",
    "timeout",
    "exclusive",
    "support-exclusive",
    "dist",
    "build",
    "group-build",
    "unknown-cost",
  ])("retains the %s admission boundary", (boundary) => {
    const rows = [row(0, 50, 5), row(1, 50, 5)];
    const other = rows[1]!;
    if (boundary === "runner") {
      other.runner = "ubuntu-24.04";
    }
    if (boundary === "concurrency") {
      rows.forEach((entry) => {
        entry.planConcurrency = 2;
      });
    }
    if (boundary === "env") {
      other.env = { OPENCLAW_VITEST_MAX_WORKERS: "8" };
    }
    if (boundary === "timeout") {
      other.timeoutMinutes = 120;
    }
    if (boundary === "exclusive") {
      other.groups[0]!.shard_name = "core-tooling-1";
    }
    if (boundary === "support-exclusive") {
      other.groups[0]!.shard_name = "agentic-agents-support-hosted-1";
      other.groups[0]!.runner = "blacksmith-32vcpu-ubuntu-2404";
    }
    if (boundary === "dist") {
      rows.forEach((entry) => {
        entry.requiresDist = true;
      });
    }
    if (boundary === "build") {
      rows.forEach((entry) => {
        entry.pretestBuildMode = "runtime";
      });
    }
    if (boundary === "group-build") {
      other.groups[0]!.pretestBuildMode = "runtime";
    }
    if (boundary === "unknown-cost") {
      delete other.predictedSeconds;
      delete other.predictedTestSeconds;
    }
    const before = descriptors(rows.flatMap((entry) => entry.groups));
    const jobs = plan(rows, "hybrid");
    expect(jobs).toHaveLength(2);
    expect(descriptors(jobs.flatMap((entry) => entry.groups!))).toEqual(before);
    expect(jobs.map((entry) => entry.groups)).toEqual(rows.map((entry) => entry.groups));
  });
});
