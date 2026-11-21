import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  shards: [] as Array<{ name: string; config: string; projects: string[] }>,
  timings: {} as Record<string, number>,
}));
vi.mock("../../test/vitest/vitest.test-shards.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../test/vitest/vitest.test-shards.mjs")>()),
  fullSuiteVitestShards: fixture.shards,
}));
vi.mock("../../scripts/lib/ci-test-timings.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/ci-test-timings.mts")>()),
  readCompactGroupTimings: () => fixture.timings,
}));
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";

type Mode = "runtime" | "private-qa" | undefined;
function setGroups(groups: Array<[string, Mode, number]>) {
  const config = (mode: Mode) =>
    mode === "private-qa"
      ? "test/vitest/vitest.extension-qa.config.ts"
      : mode === "runtime"
        ? "test/vitest/vitest.gateway-server.config.ts"
        : "test/vitest/vitest.unit-support.config.ts";
  fixture.shards.splice(
    0,
    fixture.shards.length,
    ...groups.map(([name, mode]) => ({
      name,
      config: `test/vitest/fixture-${name}.config.ts`,
      projects: [config(mode)],
    })),
  );
  fixture.timings = Object.fromEntries(
    groups.map(([name, mode, seconds]) => [
      mode === "runtime" ? `${name}-parallel` : name,
      seconds,
    ]),
  );
}
function plan(runnerBackend = "blacksmith") {
  return createNodeTestShardBundles({
    compactMode: "pull-request",
    runnerBackend,
    includeReleaseOnlyPluginShards: false,
  });
}

describe("compact node prerequisite admission", () => {
  it.each([{ seconds: [180, 100, 20], parallelJobs: 1 }])(
    "shares ordinary job setup without adding work to oversized groups: $seconds",
    (sample) => {
      for (const profile of ["blacksmith", "github", "hybrid"]) {
        setGroups(sample.seconds.map((seconds, index) => [`plain-${index}`, undefined, seconds]));
        const jobs = plan(profile);
        expect(jobs).toHaveLength(profile === "github" ? 2 : sample.parallelJobs);
        if (jobs.length === 1) {
          expect(jobs[0]).toMatchObject({
            planConcurrency: 2,
            predictedSeconds: 300,
            predictedTestSeconds: 180,
            runner: "blacksmith-32vcpu-ubuntu-2404",
          });
          expect(jobs[0]?.pretestBuildMode).toBeUndefined();
        }
      }
    },
  );
});

it("keeps admitted caps when runtime sharing competes with test balancing", () => {
  setGroups([
    ["runtime-a", "runtime", 160],
    ["runtime-b", "runtime", 10],
    ["plain-a", undefined, 150],
    ["plain-b", undefined, 20],
  ]);
  const jobs = plan();
  expect(jobs).toHaveLength(2);
  expect(jobs.every((job) => job.predictedSeconds! <= 276)).toBe(true);
  expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual([
    "plain-a",
    "plain-b",
    "runtime-a",
    "runtime-b",
  ]);
});
