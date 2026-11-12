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
const expectedGraphs = [
  "core",
  ...TSGO_CORE_TEST_SHARDS.map(({ name }) => "core-test-" + name),
  "ui",
  "test-root",
];
const compilerTasks = ["tsgo:core", "tsgo:core:test", "tsgo:ui", "tsgo:test:root"];

it.each([
  { selected: paths, tasks: compilerTasks, graphs: expectedGraphs },
  {
    selected: ["extensions/discord/index.ts", "scripts/ci-check-plan.mts"],
    tasks: ["tsgo:extensions", "tsgo:extensions:test", "tsgo:scripts"],
    graphs: ["extensions", "extensions-test", "scripts"],
  },
])("delegates only mapped compiler commands for $selected", ({ selected, tasks, graphs }) => {
  const result = detectChangedLanes(selected);
  const inline = createChangedCheckPlan(result, options);
  const delegated = createChangedCheckPlan(result, { ...options, delegateCompilers: true });
  expect(inline.delegatedTypeGraphs).toEqual([]);
  expect(
    inline.commands.filter(({ args }) => args[0]?.startsWith("tsgo:")).map(({ args }) => args[0]),
  ).toEqual(tasks);
  expect(delegated.delegatedTypeGraphs).toEqual(graphs);
  expect(delegated.commands).toEqual(
    inline.commands.filter(({ args }) => !tasks.includes(args[0]!)),
  );
  expect(
    delegated.commands.filter(({ args }) => args[0] === "lint:tmp:tsgo-core-boundary"),
  ).toHaveLength(1);
});

it.each(["github", "hybrid", "blacksmith"])(
  "assigns each delegated compiler config once on %s",
  async (runnerProfile) => {
    const plan = await createCiCheckPlan({
      typeGraphBoundaryOwner: "changed-check",
      changedBaseRef: "HEAD",
      changedPaths: paths,
      changedCoreTestPaths: null,
      runnerProfile,
      checkMatrix: {
        include: ["prod-types", "test-types", "changed-checks"].map((task) => ({
          check_name: task,
          task,
          runner: "unused",
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
    const rootConfigs: string[] = [];
    for (const row of plan.core_type_matrix.include) {
      names.push(...JSON.parse(row.type_graph_names_json ?? "[]"));
      if (row.root_type_stripe) {
        const [indexText, countText] = row.root_type_stripe.split("/");
        const index = Number(indexText);
        const count = Number(countText);
        rootConfigs.push(
          ...TSGO_ROOT_TEST_SHARDS.filter((_, offset) => offset % count === index - 1).map(
            ({ config }) => config,
          ),
        );
      }
    }
    const configs = (graphNames: string[]) =>
      expandTsgoExecutionGraphs(resolveCiTsgoGraphs(graphNames)).map(({ config }) => config);
    // Root partition names are execution-only, not canonical CI graph selectors.
    const actual = [...configs(names), ...rootConfigs].toSorted();
    expect(actual).toEqual(configs(expectedGraphs).toSorted());
    expect(new Set(actual).size).toBe(actual.length);
    const hosted = runnerProfile !== "blacksmith";
    expect(plan.core_type_matrix.include).toHaveLength(hosted ? 5 : 0);
    expect(plan.core_type_matrix.include.flatMap((row) => row.root_type_stripe ?? [])).toEqual(
      hosted ? ["1/4", "2/4", "3/4", "4/4"] : [],
    );
    expect(plan.check_matrix.include.filter(({ task }) => task === "changed-checks")).toHaveLength(
      1,
    );
    expect(plan.lint_core_matrix.include).toEqual([]);
    expect(plan.lint_extension_matrix.include).toEqual([]);
  },
);

it.each([
  ["narrow core tests", ["src/config/runtime-snapshot.test.ts"], "tsgo:core:test"],
  ["aggregate project references", ["pnpm-lock.yaml"], "tsgo:all"],
] as const)("keeps %s with its original owner", (_, selected, task) => {
  const result = detectChangedLanes([...selected]);
  const inline = createChangedCheckPlan(result, options);
  const delegated = createChangedCheckPlan(result, { ...options, delegateCompilers: true });
  expect(inline.commands.some(({ args }) => args[0] === task)).toBe(true);
  expect(delegated.commands).toEqual(inline.commands);
  expect(delegated.delegatedTypeGraphs).toEqual([]);
  expect(
    delegated.commands.filter(({ args }) => args[0] === "lint:tmp:tsgo-core-boundary"),
  ).toHaveLength(1);
});

it.each(["docs/ci/local-proof.md", "apps/android/version.json"])(
  "does not invent compiler work for %s",
  (selected) => {
    const result = detectChangedLanes([selected]);
    expect(createChangedCheckPlan(result, { ...options, delegateCompilers: true })).toEqual(
      createChangedCheckPlan(result, options),
    );
  },
);
