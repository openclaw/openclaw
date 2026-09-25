import { expect, it, vi } from "vitest";

it("combines sparse compatible infra shards without losing their files", async () => {
  const config = "test/vitest/vitest.infra.config.ts";
  const files = ["src/infra/dedupe.fixture.test.ts", "src/infra/os-summary.fixture.test.ts"];
  vi.resetModules();
  vi.doMock("../vitest/vitest.test-shards.mjs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../vitest/vitest.test-shards.mjs")>()),
    fullSuiteVitestShards: [{ name: "core-runtime", config, projects: [config] }],
  }));
  vi.doMock("../vitest/vitest.database-worker-core-paths.mjs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../vitest/vitest.database-worker-core-paths.mjs")>()),
    databaseWorkerCoreTestFiles: [],
  }));
  vi.doMock("../../scripts/lib/list-test-files.mts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../scripts/lib/list-test-files.mts")>()),
    listTrackedTestFiles: (root: string) => (root === "src/infra" ? files : []),
  }));
  try {
    const { createNodeTestShards: createBase, createNodeTestShardBundles: createBundles } =
      await import("../../scripts/lib/ci-node-test-plan.mts");
    const base = createBase();
    const bundled = createBundles();
    expect(base).toHaveLength(2);
    expect(bundled.length).toBeLessThan(base.length);
    expect(bundled.flatMap((shard) => shard.includePatterns ?? []).toSorted()).toEqual(files);
  } finally {
    vi.doUnmock("../../scripts/lib/list-test-files.mts");
    vi.doUnmock("../vitest/vitest.database-worker-core-paths.mjs");
    vi.doUnmock("../vitest/vitest.test-shards.mjs");
    vi.resetModules();
  }
});
