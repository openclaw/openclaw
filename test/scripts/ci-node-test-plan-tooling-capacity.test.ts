import { expect, it, vi } from "vitest";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
} from "../../scripts/lib/ci-node-test-plan.mts";

const fixture = vi.hoisted(() => {
  // Sixteen 200s hosted files and forty-eight 80s files share canonical families.
  // Their existing two-worker policy leaves capacity beside isolated long files.
  const files = Array.from(
    { length: 64 },
    (_, index) => `test/scripts/tooling-capacity-${String(index).padStart(2, "0")}.test.ts`,
  );
  return { files, longFiles: new Set(files.slice(0, 16)) };
});

vi.mock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
  fullSuiteVitestShards: [
    {
      config: "test/vitest/vitest.full-core-tooling.config.ts",
      name: "core-tooling",
      projects: ["test/vitest/vitest.tooling.config.ts"],
    },
  ],
}));
vi.mock("../vitest/vitest.unit-fast-paths.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vitest/vitest.unit-fast-paths.mjs")>()),
  getUnitFastTestFiles: () => [],
  getUnitFastIsolatedTestFiles: () => [],
  getUnitFastTimerTestFiles: () => [],
  getUnitFastTestFilesForIncludePatterns: () => [],
}));
vi.mock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
  listTrackedTestFiles: (rootDir: string) => (rootDir === "test" ? fixture.files : []),
}));
vi.mock("../../scripts/lib/ci-test-timings.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/ci-test-timings.mts")>()),
  readCompactGroupTimings: () => ({}),
  readToolingFileTimings: () => ({}),
}));
vi.mock("../../scripts/lib/vitest-shard-metadata.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-shard-metadata.mts")>()),
  estimateVitestToolingFileSeconds: (file: string) => (fixture.longFiles.has(file) ? 125 : 50),
}));

const options = {
  compactMode: "pull-request",
  runnerBackend: "github",
  includeReleaseOnlyPluginShards: false,
} as const;

it("uses 16-class serial tooling without moving compiler or artifact capacity", async () => {
  const protectedFiles = [
    "test/scripts/vitest-worker-artifacts.ci.test.ts",
    "test/scripts/write-unified-entry-dts.test.ts",
    "test/scripts/write-plugin-sdk-entry-dts.test.ts",
  ];
  const originalLength = fixture.files.length;
  fixture.files.push(...protectedFiles);
  vi.resetModules();
  try {
    const { createNodeTestShardBundles: createPlan } =
      await import("../../scripts/lib/ci-node-test-plan.mts");
    for (const runnerBackend of [undefined, "blacksmith"]) {
      const jobs = createPlan({ ...options, runnerBackend, compactNodeJobCap: 90 });
      const files = jobs.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!));
      expect(files.toSorted()).toEqual(fixture.files.toSorted());
      expect(new Set(files).size).toBe(files.length);
      expect(jobs.some((job) => job.runner === "blacksmith-16vcpu-ubuntu-2404")).toBe(true);
      for (const job of jobs) {
        const needsCapacity = job.groups.some((group) =>
          group.includePatterns!.some((file) => protectedFiles.includes(file)),
        );
        expect(job.runner).toBe(
          needsCapacity ? "blacksmith-32vcpu-ubuntu-2404" : "blacksmith-16vcpu-ubuntu-2404",
        );
        expect(job.planConcurrency).toBe(1);
        for (const group of job.groups) {
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        }
      }
    }
  } finally {
    fixture.files.length = originalLength;
    vi.resetModules();
  }
});

it("uses idle hosted file workers without extending indivisible walls", () => {
  const compact = createNodeTestShardBundles({ ...options, compactNodeJobCap: 16 });
  expect(compact.length).toBeLessThanOrEqual(16);
  const ownerByFile = new Map(
    createNodeTestShards(options).flatMap((shard) =>
      shard.includePatterns!.map((file) => [file, shard.shardName] as const),
    ),
  );
  const actual = compact.flatMap((job) => job.groups.flatMap((group) => group.includePatterns!));
  expect(actual.toSorted()).toEqual(fixture.files.toSorted());
  expect(new Set(actual).size).toBe(actual.length);
  for (const job of compact) {
    expect(job.planConcurrency).toBe(1);
    expect(job.requiresDist).toBe(false);
    expect(job.pretestBuildMode).toBeUndefined();
    expect(job.predictedSeconds).toBeLessThanOrEqual(300);
    expect(
      new Set(job.groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, ""))).size,
    ).toBe(job.groups.length);
    let expectedSeconds = 0;
    for (const group of job.groups) {
      expect(group.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
      expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
      const fileSeconds = group.includePatterns!.map((file) =>
        fixture.longFiles.has(file) ? 200 : 80,
      );
      expectedSeconds += Math.max(
        ...fileSeconds,
        fileSeconds.reduce((sum, seconds) => sum + seconds, 0) / 2,
      );
      const owner = group.shard_name.replace(/-hosted-\d+$/u, "");
      for (const file of group.includePatterns!) {
        expect(ownerByFile.get(file)).toBe(owner);
      }
      if (group.includePatterns!.some((file) => fixture.longFiles.has(file))) {
        // An indivisible 200s file can share its second worker, not grow its wall.
        expect(group.includePatterns!.length).toBeLessThanOrEqual(2);
      }
    }
    expect(job.predictedSeconds).toBe(expectedSeconds);
  }
  // The full 7,040s of file work cannot fit eight 300s rows with two file workers.
  expect(() => createNodeTestShardBundles({ ...options, compactNodeJobCap: 8 })).toThrow(
    "compact github node test plan exceeds 8 jobs",
  );
});
