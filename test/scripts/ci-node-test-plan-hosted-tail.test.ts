import { afterEach, expect, it, vi } from "vitest";
import { createNodeWorkerE2eTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { listWholeConfigSplitFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
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

it.each([false, true])("bounds hosted main groups (main validation: %s)", (mainValidation) => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "1");
  if (mainValidation) {
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "bun-all");
  }
  const selectedOptions = mainValidation
    ? {
        ...options,
        compactMode: "pull-request" as const,
        includeProofTests: true,
        includeReleaseOnlyToolingShards: true,
        includePrExemptRuntimeTests: true,
        mainValidation: true,
      }
    : options;
  const jobCap = mainValidation ? 77 - createNodeWorkerE2eTestShards().length : 70;
  const owners = createNodeTestShards(selectedOptions);
  const jobs = createNodeTestShardBundles({ ...selectedOptions, compactNodeJobCap: jobCap });
  expect(jobs.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(jobCap);
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
          !mainValidation &&
          (ownerName === "agentic-control-plane-agent-chat" ||
            (ownerName === "agentic-gateway-methods" && files.length > 32))
        ) {
          expect(job.groups).toHaveLength(1);
        }
        actual.push(...files);
      }
    }
    const expected = (owner.includePatterns ?? listWholeConfigSplitFiles(ownerName)!).filter(
      (file) => isRuntimeTestFileIncluded(file, selectedOptions),
    );
    expect(actual.toSorted()).toEqual(expected.toSorted());
    expect(new Set(actual).size).toBe(actual.length);
  }

  const updateJobs = jobs.filter((job) =>
    job.groups.some((group) => group.includePatterns?.includes("src/cli/update-cli.test.ts")),
  );
  expect(updateJobs).toHaveLength(1);
  const updateGroups = updateJobs[0]!.groups.filter((group) =>
    group.includePatterns?.includes("src/cli/update-cli.test.ts"),
  );
  expect(updateGroups).toHaveLength(1);
  expect(updateGroups[0]!.includePatterns).toEqual(["src/cli/update-cli.test.ts"]);
  if (!mainValidation) {
    expect(updateJobs[0]!.groups).toHaveLength(1);
  }
});
