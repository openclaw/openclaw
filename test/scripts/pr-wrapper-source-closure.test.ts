import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import {
  acceptsWorkflowPaths,
  readWorkflow,
  testNodeExecPath,
  TSX_IMPORT,
} from "./ci-workflow.test-support.js";

const components = [
  "scripts/pr",
  "scripts/pr-lib",
  ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
];

it.each([
  "src/infra/gateway-state-owner.ts",
  "src/plugins/discovery.ts",
  "src/infra/sqlite-readonly-location.worker.ts",
])(
  "retains %s and its relative ESM runtime dependencies in the wrapper inventory",
  (entrypoint) => {
    const closure = collectRuntimeImportClosure(process.cwd(), [entrypoint], {
      includeDynamicImports: true,
    });
    expect(
      closure.filter(
        (file) =>
          !components.some((component) => file === component || file.startsWith(`${component}/`)),
      ),
    ).toEqual([]);
  },
);

// Native preparation compiles the full worker inventory, including string-named
// entries. Guard excluded CI planners and standalone PR tests; the wrapper
// inventory owns its broader closure independently.
it("retains Darwin inputs inside excluded namespaces", () => {
  const workflow = readWorkflow(".github/workflows/pr-tooling-darwin.yml");
  const paths = workflow.on.pull_request.paths as string[];
  const dependencyInputs = JSON.parse(
    readFileSync("scripts/pr-lib/dependency-inputs.json", "utf8"),
  ) as { files: string[] };
  // Read descriptors in a source Node process: Vitest redirects some descriptor
  // imports into its compiled generation, whose URLs are not source inputs.
  const workerInputs = JSON.parse(
    execFileSync(
      testNodeExecPath,
      [
        "--import",
        TSX_IMPORT,
        "--input-type=module",
        "-e",
        `import {
          preservedModuleBuildAssets, preservedModuleBuildSources, vitestWorkerBuildEntries,
        } from "./scripts/lib/vitest-worker-build-entries.mts";
        import {
          vitestWorkerDeclarationEntries, vitestWorkerRuntimeAssets,
        } from "./scripts/lib/vitest-worker-declarations.mts";
        console.log(JSON.stringify([
          ...Object.values(vitestWorkerBuildEntries),
          ...Object.values(vitestWorkerDeclarationEntries),
          ...preservedModuleBuildSources,
          ...preservedModuleBuildAssets.filter(file => /\\.[cm]?[jt]s$/u.test(file)),
          ...vitestWorkerRuntimeAssets,
        ]));`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    ),
  ) as string[];
  const roots = [
    "scripts/run-vitest.mjs",
    "scripts/run-vitest-child.mts",
    "scripts/lib/vitest-worker-bootstrap.mts",
    "scripts/lib/vitest-worker-compiler.mts",
    "test/vitest/vitest.tooling.config.ts",
    "test/non-isolated-runner.ts",
    "test/setup.ts",
    "test/vitest/vitest.node-policy.global-setup.ts",
    "test/vitest/vitest.jsdom-preload.mts",
    ...workflow.jobs.darwin.steps.flatMap((step: { run?: string }) =>
      step.run?.startsWith("node scripts/run-vitest.mjs ") ? [step.run.split(" ")[2]!] : [],
    ),
    ...workerInputs,
  ];
  const inputs = new Set([
    ...components,
    ...dependencyInputs.files,
    ...collectRuntimeImportClosure(process.cwd(), roots, { includeDynamicImports: true }),
  ]);
  const excludedInputs = [...inputs].filter(
    (file) =>
      /^scripts\/lib\/ci-.*\.(?:mts|mjs)$/u.test(file) ||
      file.startsWith("test/scripts/pr-ci-sweeper") ||
      /^test\/scripts\/pr-.*\.test\.ts$/u.test(file),
  );
  expect(excludedInputs.length).toBeGreaterThan(0);
  expect(excludedInputs.filter((file) => !acceptsWorkflowPaths(paths, [file]))).toEqual([]);
});
