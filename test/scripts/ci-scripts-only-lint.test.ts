import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan, createChangedCiLintPlan } from "../../scripts/check-changed.mts";
import { createCiCheckPlan } from "../../scripts/ci-check-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const rootTest = "test/scripts/website-installer-sync-workflow.test.ts";
const workflow = ".github/workflows/website-installer-sync.yml";
const profiles = ["github", "hybrid", "blacksmith"] as const;

function fixture() {
  const cwd = tempDirs.make("ci-scripts-only-lint-");
  const write = (file: string, contents: string) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  write("package.json", '{"private":true,"type":"module"}');
  write("pnpm-workspace.yaml", "packages: [., ui, packages/*, extensions/*]\n");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { paths: { "@fixture/contract": [`./${rootTest}`] } },
    }),
  );
  write("test/tsconfig/tsconfig.test.root.json", '{"include":["../scripts/**/*.ts"]}');
  write(workflow, "name: Installer fixture\n");
  write(rootTest, "export type Contract = () => Promise<void>;\n");
  mkdirSync(path.join(cwd, "extensions"), { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  return { write };
}

it.each(profiles)("keeps installer fallback on scripts: %s", async (runnerProfile) => {
  fixture();
  const paths = [workflow, rootTest];
  const input = {
    typeGraphBoundaryOwner: "" as const,
    changedPaths: paths,
    changedCoreTestPaths: null,
    runnerProfile,
    preserveFullChecks: true,
    extensionLintMode: "affected" as const,
    checkMatrix: {
      include: ["lint", "guards", "prod-types", "test-types"].map((task) => ({
        task,
        check_name: `check-${task}`,
        runner: "unchanged",
      })),
    },
    coreTypeMatrix: { include: [{ stripe: 1 }] },
    lintCoreMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
    lintExtensionMatrix: { include: [1, 2, 3, 4, 5, 6].map((stripe) => ({ stripe })) },
  };
  const plan = await createCiCheckPlan(input);
  expect(plan.check_matrix.include.filter(({ task }) => task !== "lint")).toEqual(
    input.checkMatrix.include.filter(({ task }) => task !== "lint"),
  );
  expect(plan.check_matrix.include.find(({ task }) => task === "lint")).toMatchObject(
    input.checkMatrix.include[0]!,
  );
  expect(plan.core_type_matrix).toEqual(
    runnerProfile === "blacksmith" ? { include: [] } : input.coreTypeMatrix,
  );
  expect(plan.lint_core_matrix.include).toEqual([]);
  expect(plan.lint_extension_matrix.include).toEqual([]);
  const selection = JSON.parse(plan.central_lint_selection_json);
  expect(selection).toMatchObject({
    files: [],
    rootTestFiles: [rootTest],
    groups: [],
    fullGroups: ["scripts"],
  });
  const commands = createChangedCheckPlan(detectChangedLanes(paths), {
    lintOnly: true,
    lintSelection: selection,
    lintThreads: 1,
  }).commands;
  expect(
    commands.filter(({ args }) => args.includes("--only=scripts")).map(({ args }) => args),
  ).toEqual([
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/run-oxlint-shards.mts",
      "--only=scripts",
      "--threads=1",
    ],
  ]);
  expect(
    commands.filter(({ args }) => args[0] === "scripts/run-oxlint.mjs").map(({ args }) => args),
  ).toEqual([
    [
      "scripts/run-oxlint.mjs",
      "--tsconfig",
      "test/tsconfig/tsconfig.test.root.json",
      rootTest,
      "--threads=1",
    ],
  ]);
  expect(commands.map(({ args }) => args[0])).toEqual(
    expect.arrayContaining(["format:check", "lint:docker-e2e", "lint:tmp:no-raw-http2-imports"]),
  );
});

it.each(profiles)("keeps full scripts and real type consumers: %s", async (runnerProfile) => {
  const { write } = fixture();
  write(
    "scripts/consumer.ts",
    'import type { Contract } from "@fixture/contract"; export type Task = Contract;\n',
  );
  write(
    "src/consumer.ts",
    'import type { Task } from "../scripts/consumer.js"; export type CoreTask = Task;\n',
  );
  write(
    "ui/consumer.ts",
    'import type { CoreTask } from "../src/consumer.js"; export type UiTask = CoreTask;\n',
  );
  write(
    "extensions/example/consumer.ts",
    'import type { Contract } from "@fixture/contract"; export type PluginTask = Contract;\n',
  );
  write("src/unrelated.ts", "export const unrelated = true;\n");
  const result = detectChangedLanes([rootTest]);
  const plan = await createChangedCiLintPlan(result, { runnerProfile });
  expect(plan).not.toBeNull();
  if (!plan) {
    throw new Error("Expected full scripts lint with independent consumer selection");
  }
  const selections = [
    plan.central,
    ...[...plan.core, ...plan.extensions].map(
      ({ lint_selection_json }) => JSON.parse(lint_selection_json) as typeof plan.central,
    ),
  ];
  expect(selections.flatMap(({ files }) => files).toSorted()).toEqual([
    "extensions/example/consumer.ts",
    "src/consumer.ts",
    "ui/consumer.ts",
  ]);
  expect(plan.central.rootTestFiles).toEqual([rootTest]);
  expect(plan.central.fullGroups).toEqual(["scripts"]);
  expect(plan.central.groups).not.toContain("scripts");
  const commands = selections.flatMap(
    (lintSelection) =>
      createChangedCheckPlan(result, {
        lintOnly: true,
        lintSelection,
        lintThreads: 1,
      }).commands,
  );
  expect(commands.filter(({ args }) => args.includes("--only=scripts"))).toHaveLength(1);
  expect(commands.find(({ args }) => args.includes("--only=scripts"))!.args).not.toContain(
    "--files-json",
  );
});

it.each([
  "package.json",
  "pnpm-lock.yaml",
  ".oxlintrc.json",
  "config/tsconfig/oxlint.core.json",
  "unknown/input.ts",
  "src/deleted.ts",
  "extensions/example/deleted.ts",
])("retains full rejection for scripts mixed with %s", async (file) => {
  fixture();
  expect(
    await createChangedCiLintPlan(detectChangedLanes([rootTest, file]), {
      runnerProfile: "github",
    }),
  ).toBeNull();
});

it.each(["direct", "transitive"])("rejects %s ambient declarations", async (kind) => {
  const { write } = fixture();
  const ambient = "declare global { interface Window { task: Contract; } }\n";
  if (kind === "direct") {
    write(rootTest, `export type Contract = () => void;\n${ambient}`);
  } else {
    write("src/ambient.ts", `import type { Contract } from "@fixture/contract";\n${ambient}`);
  }
  expect(
    await createChangedCiLintPlan(detectChangedLanes([rootTest]), {
      runnerProfile: "github",
    }),
  ).toBeNull();
});
