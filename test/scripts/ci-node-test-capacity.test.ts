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
const isolatedTarget =
  "src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts";

function selectedCoreJob(selection: (typeof qualifiedCoreSelections)[number]) {
  return selectedCliJob(selection.family, [selection.target]);
}

it.each([...qualifiedCoreSelections, { family: "unit-fast-isolated", target: isolatedTarget }])(
  "retains 32-class capacity for unqualified $family siblings",
  (selection) => {
    for (const includePatterns of [
      [selection.target, "src/unqualified.test.ts"],
      ["src/unqualified.test.ts"],
    ]) {
      const job = selectedCoreJob(selection);
      job.groups[0]!.includePatterns = includePatterns;
      expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe(job.runner);
    }
  },
);

it("retains capacity when one of several groups is unqualified", () => {
  const job = selectedCliJob();
  job.groups.push({ ...job.groups[0]!, configs: ["test/vitest/vitest.tooling.config.ts"] });
  expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe(job.runner);
});

it.each([
  { family: "cli", mode: undefined, targets: undefined },
  { family: "gateway-server", mode: "hybrid", targets: undefined },
  { family: "agents-embedded-agent", mode: "pinned", targets: undefined },
  ...qualifiedCoreSelections.map(({ family, target }) => ({
    family,
    mode: "hybrid",
    targets: [target],
  })),
  { family: "unit-fast-isolated", mode: "pinned", targets: [isolatedTarget] },
])(
  "uses 16-class capacity for qualified $family selections ($mode)",
  ({ mode, family, targets }) => {
    const job = selectedCliJob(family, targets);
    if (mode === "pinned") {
      delete job.groups[0]!.fallbackMaxWorkers;
      job.groups[0]!.env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
    }
    const before = structuredClone(job);
    expect(resolveSelectedNodeTestRunner(job, mode === "pinned" ? "hybrid" : mode)).toBe(
      "blacksmith-16vcpu-ubuntu-2404",
    );
    expect(job).toEqual(before);
  },
);

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
])("retains 32-class capacity for %s", (_reason, jobOverrides, groupOverrides) => {
  const job = Object.assign(selectedCliJob(), jobOverrides);
  Object.assign(job.groups[0]!, groupOverrides);
  expect(resolveSelectedNodeTestRunner(job, "hybrid")).toBe("blacksmith-32vcpu-ubuntu-2404");
});

it("retains hosted placement", () => {
  const job = selectedCliJob();
  expect(resolveSelectedNodeTestRunner(job, "github")).toBe(job.runner);
});
