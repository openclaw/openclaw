import { expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";
import { createCiCheckPlan } from "../../scripts/ci-check-plan.mts";
import {
  expandTsgoExecutionGraphs,
  resolveCiTsgoGraphs,
  TSGO_CORE_TEST_SHARDS,
  TSGO_ROOT_TEST_SHARDS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";

const paths = [
  "docs/.generated/config-baseline.counts.json",
  "config/assertion-safety-baseline.txt",
  "src/config/runtime-snapshot.ts",
  "test/system-agent-delegation-authority.e2e.test.ts",
  "ui/src/styles/layout.css",
];
const options = { env: { PATH: "/usr/bin" }, base: "HEAD", head: "HEAD" };
const compilerTasks = ["tsgo:core", "tsgo:core:test", "tsgo:ui", "tsgo:test:root"];
const expectedGraphs = [
  "core",
  ...TSGO_CORE_TEST_SHARDS.map(({ name }) => "core-test-" + name),
  "ui",
  "test-root",
];

it("removes only the explicitly mapped compiler commands from the selected check plan", () => {
  const result = detectChangedLanes(paths);
  const inline = createChangedCheckPlan(result, options);
  const delegated = createChangedCheckPlan(result, { ...options, delegateCompilers: true });
  expect(inline.delegatedTypeGraphs).toEqual([]);
  expect(
    inline.commands.filter(({ args }) => args[0]?.startsWith("tsgo:")).map(({ args }) => args[0]),
  ).toEqual(compilerTasks);
  expect(delegated.delegatedTypeGraphs).toEqual(expectedGraphs);
  expect(delegated.commands).toEqual(
    inline.commands.filter(({ args }) => !compilerTasks.includes(args[0]!)),
  );
  expect(
    delegated.commands.filter(({ args }) => args[0] === "lint:tmp:tsgo-core-boundary"),
  ).toHaveLength(1);
});

it("assigns the complete delegated graph union once using native stripes and root partitions", async () => {
  const plan = await createCiCheckPlan({
    typeGraphBoundaryOwner: "changed-check",
    changedBaseRef: "HEAD",
    changedPaths: paths,
    changedCoreTestPaths: null,
    runnerProfile: "github",
    checkMatrix: {
      include: ["prod-types", "test-types", "changed-checks"].map((task) => ({
        check_name: task,
        task,
        runner: "ubuntu-24.04",
      })),
    },
    coreTypeMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
    lintCoreMatrix: { include: [] },
    lintExtensionMatrix: { include: [] },
  });
  const names: string[] = plan.check_matrix.include.flatMap((row) => [
    ...JSON.parse(row.type_graph_names_json ?? "[]"),
    ...JSON.parse(row.core_type_graph_names_json ?? "[]"),
  ]);
  for (const row of plan.core_type_matrix.include) {
    names.push(...JSON.parse(row.type_graph_names_json ?? "[]"));
    if (row.root_type_stripe) {
      const [indexText, countText] = row.root_type_stripe.split("/");
      const index = Number(indexText);
      const count = Number(countText);
      names.push(
        ...TSGO_ROOT_TEST_SHARDS.filter((_, offset) => offset % count === index - 1).map(
          ({ name }) => name,
        ),
      );
    }
  }
  const configs = (graphNames: string[]) =>
    expandTsgoExecutionGraphs(resolveCiTsgoGraphs(graphNames))
      .map(({ config }) => config)
      .toSorted();
  const actual = configs(names);
  const expected = configs(expectedGraphs);
  expect(actual).toEqual(expected);
  expect(new Set(actual).size).toBe(actual.length);
  expect(plan.core_type_matrix.include).toHaveLength(5);
  expect(plan.check_matrix.include.filter(({ task }) => task === "changed-checks")).toHaveLength(1);
});

it.each([
  ["narrow core tests", ["src/config/runtime-snapshot.test.ts"], "tsgo:core:test"],
  ["aggregate project references", ["pnpm-lock.yaml"], "tsgo:all"],
] as const)("keeps %s with its original execution owner", (_, selected, task) => {
  const result = detectChangedLanes([...selected]);
  const inline = createChangedCheckPlan(result, options);
  const delegated = createChangedCheckPlan(result, { ...options, delegateCompilers: true });
  expect(inline.commands.some(({ args }) => args[0] === task)).toBe(true);
  expect(delegated.commands).toEqual(inline.commands);
  expect(delegated.delegatedTypeGraphs).toEqual([]);
  expect(delegated.commands.some(({ args }) => args[0] === task)).toBe(true);
  expect(
    delegated.commands.filter(({ args }) => args[0] === "lint:tmp:tsgo-core-boundary"),
  ).toHaveLength(1);
});

it.each([["docs/ci/local-proof.md"], ["apps/android/version.json"]])(
  "does not invent compiler work for a compiler-free selection %j",
  (selected) => {
    const result = detectChangedLanes([selected]);
    expect(createChangedCheckPlan(result, { ...options, delegateCompilers: true })).toEqual(
      createChangedCheckPlan(result, options),
    );
  },
);
