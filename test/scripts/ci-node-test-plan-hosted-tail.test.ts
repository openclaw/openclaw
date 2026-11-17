import { afterEach, expect, it, vi } from "vitest";
import { createNodeWorkerE2eTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { listWholeConfigSplitFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  isRuntimeTestFileIncluded,
} from "../../scripts/lib/ci-node-test-plan.mts";

const options = {
  compact: true,
  compactMode: "push",
  mainValidation: false,
  runnerBackend: "github",
  includeProofTests: true,
  includeReleaseOnlyPluginShards: false,
  includeReleaseOnlyToolingShards: false,
  includeReleaseOnlyRuntimeTests: false,
  includePrExemptRuntimeTests: true,
} as const;

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("bounds hosted main groups (main validation: %s)", (mainValidation) => {
  vi.stubEnv("CI", "true");
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "1");
  vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "bun-all");
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
  const workerRows = createNodeWorkerE2eTestShards();
  expect(workerRows).toHaveLength(2);
  expect(workerRows.every((row) => !row.requiresDist && row.planConcurrency === 1)).toBe(true);
  const totalJobCap = mainValidation ? 77 : 70;
  const jobCap = totalJobCap - workerRows.length;
  const owners = createNodeTestShards(selectedOptions);
  const jobs = createNodeTestShardBundles({ ...selectedOptions, compactNodeJobCap: jobCap });
  expect(jobs.filter((job) => !job.requiresDist).length + workerRows.length).toBeLessThanOrEqual(
    totalJobCap,
  );
  expect(jobs.length).toBeLessThanOrEqual(mainValidation ? 90 : 69);

  if (!mainValidation) {
    const reducedOwners = owners.filter(
      (owner) =>
        /^core-tooling-\d+$/u.test(owner.shardName) || owner.shardName === "agentic-cli-process",
    );
    const expectedFiles = reducedOwners.flatMap((owner) =>
      (owner.includePatterns ?? listWholeConfigSplitFiles(owner.shardName)!).map((file) =>
        JSON.stringify([owner.configs, file]),
      ),
    );
    const actualFiles: string[] = [];
    for (const job of jobs) {
      for (const group of job.groups) {
        if (
          !/^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name) &&
          !/^agentic-cli-process(?:-hosted-\d+)?$/u.test(group.shard_name)
        ) {
          continue;
        }
        expect(group.includePatterns?.length).toBeGreaterThan(0);
        actualFiles.push(
          ...group.includePatterns!.map((file) => JSON.stringify([group.configs, file])),
        );
        expect(job.planConcurrency).toBe(1);
        expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        expect([undefined, "2"]).toContain(job.env?.OPENCLAW_VITEST_MAX_WORKERS);
        if (!group.requiresDist && group.pretestBuildMode === undefined) {
          expect(group.fallbackMaxWorkers).toBeUndefined();
          expect(group.minTotalMemoryBytes).toBeUndefined();
        }
      }
    }
    // Compare multisets: a duplicate must not hide a missing retained file.
    expect(actualFiles.toSorted()).toEqual(expectedFiles.toSorted());
  }

  for (const [ownerName, maxFiles] of [
    ["agentic-control-plane-agent-chat", 30],
    ["agentic-gateway-methods", 96],
    ["agentic-agents-support", 64],
    ["core-runtime-config", 64],
    ["agentic-commands-status-tools", 64],
    ["agentic-commands-doctor", 64],
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
        if (
          ownerName !== "core-runtime-infra-storage-state" &&
          ownerName !== "agentic-agents-support" &&
          !ownerName.startsWith("agentic-commands-")
        ) {
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        }
        if (ownerName === "agentic-agents-support") {
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBeUndefined();
        }
        if (ownerName.startsWith("agentic-commands-")) {
          expect(Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? group.fallbackMaxWorkers)).toBe(
            2,
          );
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
