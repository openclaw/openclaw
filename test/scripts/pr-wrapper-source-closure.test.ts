import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mts";
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

const wrapperRoots = [
  "src/infra/gateway-state-owner.ts",
  "src/plugins/discovery.ts",
  "src/infra/sqlite-readonly-location.worker.ts",
];

// Native preparation also compiles string-named workers. Query both inventories
// in one graph while retaining their separate closure and routing assertions.
it("retains wrapper runtime dependencies and Darwin inputs inside excluded namespaces", () => {
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
        import { vitestWorkerDeclarationEntries } from "./scripts/lib/vitest-worker-declarations.mts";
        import { vitestWorkerRuntimeAssets } from "./scripts/lib/package-root-modules.mts";
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
      step.run?.startsWith("node scripts/run-vitest.mjs ")
        ? step.run.split(/\s+/u).filter((arg) => arg.endsWith(".test.ts"))
        : [],
    ),
    ...workerInputs,
  ];
  using graph = createRuntimeImportGraph(process.cwd(), [...wrapperRoots, ...roots], {
    includeDynamicImports: true,
  });
  expect(
    graph
      .collect(wrapperRoots)
      .filter(
        (file) =>
          !components.some((component) => file === component || file.startsWith(`${component}/`)),
      ),
  ).toEqual([]);
  const inputs = new Set([...components, ...dependencyInputs.files, ...graph.collect(roots)]);
  const excludedInputs = [...inputs].filter(
    (file) =>
      /^scripts\/lib\/ci-.*\.(?:mts|mjs)$/u.test(file) ||
      file.startsWith("test/scripts/pr-ci-sweeper") ||
      file.startsWith("test/helpers/") ||
      /^test\/scripts\/pr-.*\.test\.ts$/u.test(file),
  );
  expect(excludedInputs.length).toBeGreaterThan(0);
  expect(excludedInputs.filter((file) => !acceptsWorkflowPaths(paths, [file]))).toEqual([]);
});
