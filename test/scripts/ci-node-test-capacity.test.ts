import { expect, it } from "vitest";
import { resolveSelectedNodeTestRunner } from "../../scripts/lib/ci-node-test-capacity.mts";
import type { CompactNodeTestShard } from "../../scripts/lib/ci-node-test-plan.mts";

function selectedCliJob(): CompactNodeTestShard {
  return {
    checkName: "checks-node-changed-compact-small-1",
    shardName: "changed-compact-small-1",
    runner: "blacksmith-32vcpu-ubuntu-2404",
    requiresDist: false,
    planConcurrency: 1,
    groups: [
      {
        shard_name: "agentic-cli-hosted-1",
        configs: ["test/vitest/vitest.cli.config.ts"],
        runner: "blacksmith-4vcpu-ubuntu-2404",
        requiresDist: false,
        fallbackMaxWorkers: 2,
        includePatterns: ["src/cli/first.test.ts", "src/cli/second.test.ts"],
      },
    ],
  };
}

it.each([undefined, "blacksmith", "hybrid"])(
  "uses 16-class capacity for a complete two-file serial CLI selection (%s)",
  (backend) => {
    expect(resolveSelectedNodeTestRunner(selectedCliJob(), backend)).toBe(
      "blacksmith-16vcpu-ubuntu-2404",
    );
  },
);

it.each<{
  reason: string;
  change: (job: CompactNodeTestShard) => void;
}>([
  {
    reason: "parallel plans",
    change: (job) => {
      job.planConcurrency = 2;
    },
  },
  {
    reason: "runtime preparation",
    change: (job) => {
      job.pretestBuildMode = "runtime";
    },
  },
  {
    reason: "dist preparation",
    change: (job) => {
      job.groups[0]!.requiresDist = true;
    },
  },
  {
    reason: "memory floor",
    change: (job) => {
      job.groups[0]!.minTotalMemoryBytes = 28 * 1024 ** 3;
    },
  },
  {
    reason: "explicit large anchor",
    change: (job) => {
      job.groups[0]!.runner = "blacksmith-32vcpu-ubuntu-2404";
    },
  },
  {
    reason: "wider worker allowance",
    change: (job) => {
      job.groups[0]!.includePatterns!.push("src/cli/third.test.ts");
    },
  },
  {
    reason: "whole-config inventory",
    change: (job) => {
      delete job.groups[0]!.includePatterns;
    },
  },
  {
    reason: "mixed config",
    change: (job) => {
      job.groups[0]!.configs.push("test/vitest/vitest.tooling.config.ts");
    },
  },
])("retains 32-class capacity for $reason", ({ change }) => {
  const job = selectedCliJob();
  change(job);
  expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-32vcpu-ubuntu-2404");
});

it("retains hosted placement", () => {
  const job = selectedCliJob();
  expect(resolveSelectedNodeTestRunner(job, "github")).toBe(job.runner);
});
