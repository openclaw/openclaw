import { expect, it, vi } from "vitest";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";

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

it("uses idle hosted file workers on overflow without extending indivisible walls", () => {
  const baseline = createNodeTestShardBundles({ ...options, compactNodeJobCap: 24 });
  expect(baseline).toHaveLength(20);
  const compact = createNodeTestShardBundles({ ...options, compactNodeJobCap: 16 });
  expect(compact).toHaveLength(16);
  const ownerByFile = new Map(
    baseline.flatMap((job) =>
      job.groups.flatMap((group) =>
        group.includePatterns!.map(
          (file) => [file, group.shard_name.replace(/-hosted-\d+$/u, "")] as const,
        ),
      ),
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
    for (const group of job.groups) {
      expect(group.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
      expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
      const owner = group.shard_name.replace(/-hosted-\d+$/u, "");
      for (const file of group.includePatterns!) {
        expect(ownerByFile.get(file)).toBe(owner);
      }
      if (group.includePatterns!.some((file) => fixture.longFiles.has(file))) {
        expect(group.includePatterns).toHaveLength(2);
        expect(group.includePatterns!.every((file) => fixture.longFiles.has(file))).toBe(true);
        const tails = job.groups.filter((entry) => entry !== group);
        for (const tail of tails) {
          expect(tail.includePatterns!.length).toBeLessThanOrEqual(2);
          expect(tail.includePatterns!.every((file) => !fixture.longFiles.has(file))).toBe(true);
        }
        // The pair still costs 200s; each separate short-file child costs 80s.
        expect(job.predictedSeconds).toBe(200 + 80 * tails.length);
      }
    }
  }
  // The full 7,040s of file work cannot fit eight 300s rows with two file workers.
  expect(() => createNodeTestShardBundles({ ...options, compactNodeJobCap: 8 })).toThrow(
    "compact github node test plan exceeds 8 jobs",
  );
});
