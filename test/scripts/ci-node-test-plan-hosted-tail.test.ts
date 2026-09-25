import { afterEach, expect, it, vi } from "vitest";
import {
  listWholeConfigFiles,
  listWholeConfigSplitFiles,
} from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  isRuntimeTestFileIncluded,
} from "../../scripts/lib/ci-node-test-plan.mts";

const options = {
  compactMode: "push",
  runnerBackend: "github",
  includeReleaseOnlyPluginShards: false,
  includeReleaseOnlyToolingShards: false,
  includeReleaseOnlyRuntimeTests: false,
} as const;

afterEach(() => vi.unstubAllEnvs());

it("keeps hourly hosted tails parallel without losing tests or increasing worker limits", () => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "1");
  const owners = createNodeTestShards(options);
  const jobs = createNodeTestShardBundles({ ...options, compactNodeJobCap: 70 });
  expect(jobs.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(70);
  expect(jobs.length).toBeLessThanOrEqual(90);

  for (const [ownerName, maxFiles] of [
    ["agentic-control-plane-agent-chat", 30],
    ["agentic-gateway-methods", 96],
    ["core-runtime-infra-storage-state", 64],
  ] as const) {
    const owner = owners.find((entry) => entry.shardName === ownerName)!;
    const actual: string[] = [];
    for (const job of jobs) {
      for (const group of job.groups.filter(
        (entry) => entry.shard_name.replace(/-hosted-\d+$/u, "") === ownerName,
      )) {
        const files = group.includePatterns!;
        expect(files.length).toBeGreaterThan(0);
        expect(files.length).toBeLessThanOrEqual(maxFiles);
        expect(group.configs).toEqual(owner.configs);
        expect(group.requiresDist).toBe(owner.requiresDist);
        expect(job.planConcurrency).toBe(1);
        if (ownerName !== "core-runtime-infra-storage-state") {
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        }
        if (
          ownerName === "agentic-control-plane-agent-chat" ||
          (ownerName === "agentic-gateway-methods" && files.length > 32)
        ) {
          expect(job.groups).toHaveLength(1);
        }
        actual.push(...files);
      }
    }
    const expected = (owner.includePatterns ?? listWholeConfigSplitFiles(ownerName)!).filter(
      (file) => isRuntimeTestFileIncluded(file, options),
    );
    expect(actual.toSorted()).toEqual(expected.toSorted());
    expect(new Set(actual).size).toBe(actual.length);
  }

  const updateJobs = jobs.filter((job) =>
    job.groups.some((group) => group.includePatterns?.includes("src/cli/update-cli.test.ts")),
  );
  expect(updateJobs).toHaveLength(1);
  expect(updateJobs[0]!.groups).toHaveLength(1);
  expect(updateJobs[0]!.groups[0]!.includePatterns).toEqual(["src/cli/update-cli.test.ts"]);
});

it("keeps measured hosted PR rows bounded while preserving their complete file owners", () => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "1");
  const prOptions = {
    ...options,
    compactMode: "pull-request" as const,
    runnerBackend: "github-pr",
    includeReleaseOnlyToolingShards: true,
    includeProofTests: false,
  };
  const owners = createNodeTestShards(prOptions);
  const jobs = createNodeTestShardBundles(prOptions);
  expect(jobs.length).toBeLessThanOrEqual(120);
  expect(jobs.every((job) => job.planConcurrency === 1)).toBe(true);
  expect(Math.max(...jobs.map((job) => job.predictedSeconds!))).toBeLessThanOrEqual(450);

  for (const name of [
    "agentic-cli",
    "agentic-cli-process",
    "agentic-gateway-methods",
    "core-runtime-infra-storage-state",
  ]) {
    const owner = owners.find((entry) => entry.shardName === name)!;
    const groups = jobs
      .flatMap((job) => job.groups)
      .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === name);
    const expected = (owner.includePatterns ?? listWholeConfigFiles(name)!).filter((file) =>
      isRuntimeTestFileIncluded(file, prOptions),
    );
    expect(groups.flatMap((group) => group.includePatterns!).toSorted(), name).toEqual(
      expected.toSorted(),
    );
    for (const group of groups) {
      expect(group.configs, name).toEqual(owner.configs);
      expect(group.requiresDist, name).toBe(owner.requiresDist);
      if (name === "core-runtime-infra-storage-state") {
        expect(group.includePatterns!.length).toBeLessThanOrEqual(32);
      } else {
        expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS, name).toBe("2");
      }
    }
  }
  const health = jobs
    .flatMap((job) => job.groups)
    .filter((group) =>
      group.includePatterns?.includes("src/cli/gateway-backed-exit-health.process.test.ts"),
    );
  expect(health).toHaveLength(1);
  expect(health[0]!.includePatterns).toEqual([
    "src/cli/gateway-backed-exit-health.process.test.ts",
  ]);
});
