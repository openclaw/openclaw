import { expect, it } from "vitest";
import { resolveSelectedNodeTestRunner } from "../../scripts/lib/ci-node-test-capacity.mts";
import type { CompactNodeTestShard } from "../../scripts/lib/ci-node-test-plan.mts";

function selectedCliJob(
  family = "cli",
  includePatterns = ["src/cli/first.test.ts", "src/cli/second.test.ts"],
): CompactNodeTestShard {
  return {
    checkName: "checks-node-changed-compact-small-1",
    shardName: "changed-compact-small-1",
    runner: "blacksmith-32vcpu-ubuntu-2404",
    requiresDist: false,
    planConcurrency: 1,
    groups: [
      {
        shard_name: "agentic-cli-hosted-1",
        configs: [`test/vitest/vitest.${family}.config.ts`],
        runner: "blacksmith-4vcpu-ubuntu-2404",
        requiresDist: false,
        fallbackMaxWorkers: 2,
        includePatterns,
      },
    ],
  };
}

const qualifiedCoreSelections = [
  { family: "gateway-core", target: "src/gateway/mcp-app-extension-runtime.test.ts" },
  { family: "agents-core", target: "src/agents/cli-runner.helpers.test.ts" },
];
const serialFamilies = ["cli", "gateway-client", "gateway-server", "agents-embedded-agent"];
const isolatedTarget =
  "src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts";

function selectedCoreJob(selection: (typeof qualifiedCoreSelections)[number]) {
  return selectedCliJob(selection.family, [selection.target]);
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
    const group = selectedCliJob(family, [target]).groups[0]!;
    group.shard_name = family;
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

it.each([
  ...qualifiedCoreSelections.map((selection) =>
    Object.assign({ placements: ["same", "separate", "replacement"] }, selection),
  ),
  { family: "unit-fast-isolated", target: isolatedTarget, placements: ["same", "separate"] },
])("retains 32-class capacity for unqualified $family siblings", (selection) => {
  for (const placement of selection.placements) {
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
});

it.each(
  [undefined, "blacksmith", "hybrid", "pinned"].flatMap((mode) =>
    serialFamilies.map((family) => ({ mode, family })),
  ),
)("uses 16-class capacity for two-file $family selections ($mode)", ({ mode, family }) => {
  const job = selectedCliJob(family);
  if (mode === "pinned") {
    delete job.groups[0]!.fallbackMaxWorkers;
    job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
  }
  expect(resolveSelectedNodeTestRunner(job, mode === "pinned" ? "hybrid" : mode)).toBe(
    "blacksmith-16vcpu-ubuntu-2404",
  );
});

type Group = CompactNodeTestShard["groups"][number];
it.each<[string, Partial<CompactNodeTestShard>, Partial<Group>]>([
  ["parallel plans", { planConcurrency: 2 }, {}],
  ["runtime preparation", { pretestBuildMode: "runtime" }, {}],
  ["dist preparation", {}, { requiresDist: true }],
  ["memory floor", {}, { minTotalMemoryBytes: 28 * 1024 ** 3 }],
  ["explicit large anchor", {}, { runner: "blacksmith-32vcpu-ubuntu-2404" }],
  ["wider worker allowance", {}, { includePatterns: ["first", "second", "third"] }],
  ["whole-config inventory", {}, { includePatterns: undefined }],
  [
    "mixed config",
    {},
    { configs: ["test/vitest/vitest.cli.config.ts", "test/vitest/vitest.tooling.config.ts"] },
  ],
  ["unqualified config", {}, { configs: ["test/vitest/vitest.unit-fast-isolated.config.ts"] }],
  ["missing worker bound", {}, { fallbackMaxWorkers: undefined }],
  [
    "explicit wide worker pin despite a two-worker fallback",
    {},
    { env: { OPENCLAW_VITEST_MAX_WORKERS: "4" } },
  ],
  [
    "resource-gated tooling inventory",
    {},
    {
      configs: ["test/vitest/vitest.tooling.config.ts"],
      includePatterns: ["test/scripts/vitest-worker-artifacts.ci.test.ts"],
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    },
  ],
])("retains 32-class capacity for %s", (_reason, jobOverrides, groupOverrides) => {
  for (const job of [selectedCliJob(), ...qualifiedCoreSelections.map(selectedCoreJob)]) {
    Object.assign(job, jobOverrides);
    Object.assign(job.groups[0]!, groupOverrides);
    expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-32vcpu-ubuntu-2404");
  }
});

it("retains 32-class capacity for an unqualified sibling in a mixed selected job", () => {
  for (const job of [selectedCliJob(), ...qualifiedCoreSelections.map(selectedCoreJob)]) {
    job.groups[0]!.configs = ["test/vitest/vitest.agents-embedded-agent.config.ts"];
    job.groups.push({
      ...job.groups[0]!,
      shard_name: "agentic-agents-embedded-run",
      configs: ["test/vitest/vitest.agents-embedded-agent-run.config.ts"],
      includePatterns: [
        "src/agents/embedded-agent-runner/run/attempt-transcript-helpers.presence.test.ts",
      ],
    });
    expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-32vcpu-ubuntu-2404");
  }
});

it("retains hosted placement", () => {
  for (const job of [selectedCliJob(), ...qualifiedCoreSelections.map(selectedCoreJob)]) {
    expect(resolveSelectedNodeTestRunner(job, "github")).toBe(job.runner);
  }
});

it("uses 16-class capacity for the qualified isolated LLM boundary selection", () => {
  const job = selectedCliJob("unit-fast-isolated", [isolatedTarget]);
  job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
  expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-16vcpu-ubuntu-2404");
});
