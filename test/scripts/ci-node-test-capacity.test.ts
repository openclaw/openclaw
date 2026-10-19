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

const qualifiedCoreSelections = [
  {
    family: "gateway-core",
    target: "src/gateway/mcp-app-extension-runtime.test.ts",
  },
  {
    family: "agents-core",
    target: "src/agents/cli-runner.helpers.test.ts",
  },
];

function selectedCoreJob(selection: (typeof qualifiedCoreSelections)[number]) {
  const job = selectedCliJob();
  job.groups[0]!.configs = [`test/vitest/vitest.${selection.family}.config.ts`];
  job.groups[0]!.includePatterns = [selection.target];
  return job;
}

it("right-sizes qualified serial selections while retaining parallel capacity and scope", () => {
  const selections = [
    {
      family: "agents-embedded-agent",
      target: "src/agents/embedded-agent-runner/effective-tool-policy.test.ts",
    },
    { family: "gateway-client", target: "src/gateway/client-callsites.guard.test.ts" },
    ...qualifiedCoreSelections,
  ];
  const job = selectedCliJob();
  job.groups = selections.map(({ family, target }) => {
    const group = selectedCliJob().groups[0]!;
    group.shard_name = family;
    group.configs = [`test/vitest/vitest.${family}.config.ts`];
    group.includePatterns = [target];
    return group;
  });
  for (const planConcurrency of [1, 2]) {
    job.planConcurrency = planConcurrency;
    const before = structuredClone(job);
    for (const backend of [undefined, "blacksmith", "hybrid"]) {
      expect(resolveSelectedNodeTestRunner(job, backend)).toBe(
        planConcurrency === 1 ? "blacksmith-16vcpu-ubuntu-2404" : "blacksmith-32vcpu-ubuntu-2404",
      );
      expect(job).toEqual(before);
    }
  }
});

it.each(qualifiedCoreSelections)(
  "retains 32-class capacity for unqualified $family siblings",
  (selection) => {
    for (const placement of ["same", "separate", "replacement"]) {
      const job = selectedCoreJob(selection);
      const group = job.groups[0]!;
      const sibling = "src/unqualified.test.ts";
      if (placement === "same") {
        group.includePatterns!.push(sibling);
      } else if (placement === "separate") {
        job.groups.push({ ...group, includePatterns: [sibling] });
      } else {
        group.includePatterns = [sibling];
      }
      expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe(job.runner);
    }
  },
);

it.each(
  [undefined, "blacksmith", "hybrid"].flatMap((backend) =>
    ["cli", "gateway-client", "gateway-server", "agents-embedded-agent"].map((family) => ({
      backend,
      family,
    })),
  ),
)(
  "uses 16-class capacity for a complete two-file serial $family selection ($backend)",
  ({ backend, family }) => {
    const job = selectedCliJob();
    job.groups[0]!.configs = [`test/vitest/vitest.${family}.config.ts`];
    expect(resolveSelectedNodeTestRunner(job, backend)).toBe("blacksmith-16vcpu-ubuntu-2404");
  },
);

it.each(["cli", "gateway-client", "gateway-server", "agents-embedded-agent"])(
  "uses 16-class capacity for explicitly pinned two-worker %s selections",
  (family) => {
    const job = selectedCliJob();
    job.groups[0]!.configs = [`test/vitest/vitest.${family}.config.ts`];
    delete job.groups[0]!.fallbackMaxWorkers;
    job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
    expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-16vcpu-ubuntu-2404");
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
    reason: "unqualified config",
    change: (job) => {
      job.groups[0]!.configs = ["test/vitest/vitest.unit-fast-isolated.config.ts"];
    },
  },
  {
    reason: "an unqualified sibling in a mixed selected job",
    change: (job) => {
      job.groups[0]!.configs = ["test/vitest/vitest.agents-embedded-agent.config.ts"];
      job.groups.push({
        ...job.groups[0]!,
        shard_name: "agentic-agents-embedded-run",
        configs: ["test/vitest/vitest.agents-embedded-agent-run.config.ts"],
        includePatterns: [
          "src/agents/embedded-agent-runner/run/attempt-transcript-helpers.presence.test.ts",
        ],
      });
    },
  },
  {
    reason: "missing worker bound",
    change: (job) => {
      delete job.groups[0]!.fallbackMaxWorkers;
    },
  },
  {
    reason: "explicit wide worker pin despite a two-worker fallback",
    change: (job) => {
      job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "4" };
    },
  },
  {
    reason: "resource-gated tooling inventory",
    change: (job) => {
      job.groups[0]!.configs = ["test/vitest/vitest.tooling.config.ts"];
      job.groups[0]!.includePatterns = ["test/scripts/vitest-worker-artifacts.ci.test.ts"];
      job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
    },
  },
])("retains 32-class capacity for $reason", ({ change }) => {
  for (const job of [selectedCliJob(), ...qualifiedCoreSelections.map(selectedCoreJob)]) {
    change(job);
    expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-32vcpu-ubuntu-2404");
  }
});

it("retains hosted placement", () => {
  for (const job of [selectedCliJob(), ...qualifiedCoreSelections.map(selectedCoreJob)]) {
    expect(resolveSelectedNodeTestRunner(job, "github")).toBe(job.runner);
  }
});

it("uses 16-class capacity for the qualified isolated LLM boundary selection", () => {
  const job = selectedCliJob();
  job.groups[0]!.configs = ["test/vitest/vitest.unit-fast-isolated.config.ts"];
  job.groups[0]!.includePatterns = [
    "src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts",
  ];
  job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
  expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-16vcpu-ubuntu-2404");
});

it.each(["same", "separate"])(
  "retains 32-class capacity with an unqualified isolated sibling in the %s group",
  (placement) => {
    const job = selectedCliJob();
    const group = job.groups[0]!;
    group.configs = ["test/vitest/vitest.unit-fast-isolated.config.ts"];
    group.includePatterns = [
      "src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts",
    ];
    const sibling = "src/agents/embedded-agent-runner/run/unqualified.test.ts";
    if (placement === "same") {
      group.includePatterns.push(sibling);
    } else {
      job.groups.push({ ...group, includePatterns: [sibling] });
    }
    expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-32vcpu-ubuntu-2404");
  },
);
