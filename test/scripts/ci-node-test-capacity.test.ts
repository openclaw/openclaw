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

it.each(
  [undefined, "blacksmith", "hybrid"].flatMap((backend) =>
    ["cli", "gateway-client"].map((family) => ({ backend, family })),
  ),
)(
  "uses 16-class capacity for a complete two-file serial $family selection ($backend)",
  ({ backend, family }) => {
    const job = selectedCliJob();
    if (family === "gateway-client") {
      job.groups[0]!.shard_name = "agentic-gateway-core-2-hosted-1";
      job.groups[0]!.configs = ["test/vitest/vitest.gateway-client.config.ts"];
      job.groups[0]!.includePatterns = ["src/gateway/first.test.ts", "src/gateway/second.test.ts"];
    }
    expect(resolveSelectedNodeTestRunner(job, backend)).toBe("blacksmith-16vcpu-ubuntu-2404");
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
  {
    reason: "Gateway owner with a CLI config",
    change: (job) => {
      job.groups[0]!.shard_name = "agentic-gateway-core-2-hosted-1";
    },
  },
  {
    reason: "CLI owner with a Gateway config",
    change: (job) => {
      job.groups[0]!.configs = ["test/vitest/vitest.gateway-client.config.ts"];
    },
  },
  {
    reason: "another Gateway family",
    change: (job) => {
      job.groups[0]!.shard_name = "agentic-gateway-core-1-hosted-1";
      job.groups[0]!.configs = ["test/vitest/vitest.gateway-client.config.ts"];
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
