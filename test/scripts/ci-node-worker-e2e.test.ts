import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createChangedNodeTestShards,
  createNodeWorkerE2eTestShards,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { NODE_WORKER_E2E_TEST_FILES } from "../../scripts/lib/ci-node-worker-e2e-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { selectedFiles } from "./ci-changed-node-test-plan.test-support.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimeRoot = "test/e2e/qa-lab/runtime";
const expectedFiles = readdirSync(runtimeRoot)
  .filter((file) =>
    /^(?:cloud-worker-|(?:codex|gateway)-node-|node-worker-launch-|paired-node-worker-|native-worker-|required-native-|skill-library-worker-).*\.e2e\.test\.ts$/u.test(
      file,
    ),
  )
  .map((file) => `${runtimeRoot}/${file}`)
  .toSorted();

it("selects node-worker process proofs for their owners without static test imports", () => {
  const cwd = tempDirs.make("node-worker-e2e-owners-");
  const owners = [
    "src/gateway/worker-environments/node-launch-adapter.ts",
    "src/node-host/node-worker-supervisor.ts",
    "src/worker/worker-process.ts",
    "src/gateway/node-registry.ts",
    "src/cli/node-cli/register.ts",
  ];
  for (const file of [...owners, ...expectedFiles, "docs/ci.md"]) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), "export {};\n");
  }
  for (const owner of owners) {
    const options = {
      cwd,
      selectionMode: "aggressive" as const,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    };
    const targets = resolveChangedNodeTestTargets([owner], options);
    const rows = createChangedNodeTestShards([owner], { ...options, selectedTestTargets: targets });
    expect(rows, owner).not.toBeNull();
    expect(
      selectedFiles(rows)
        .filter((file) => file.startsWith(runtimeRoot))
        .toSorted(),
    ).toEqual(expectedFiles);
  }
  expect(
    resolveChangedNodeTestTargets(["docs/ci.md"], { cwd, selectionMode: "aggressive" }),
  ).toEqual([]);
  expect(NODE_WORKER_E2E_TEST_FILES.toSorted()).toEqual(expectedFiles);
});

it("balances hourly node-worker E2Es inside the existing matrix capacity", () => {
  const rows = createNodeWorkerE2eTestShards();
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.planConcurrency === 1)).toBe(true);
  expect(rows.every((row) => row.runner === "blacksmith-8vcpu-ubuntu-2404")).toBe(true);
  expect(Math.max(...rows.map((row) => row.predictedSeconds ?? Infinity))).toBeLessThanOrEqual(
    1_260,
  );
  expect(rows.flatMap((row) => row.targets ?? []).toSorted()).toEqual(expectedFiles);
  expect(rows.every((row) => row.pretestBuildMode === "private-qa")).toBe(true);
  const result = runCiManifestFixture({
    bundledPlanner: true,
    eventName: "schedule",
    changedPaths: null,
    targetFiles: expectedFiles,
    scopeEnv: {
      OPENCLAW_CI_VALIDATION_TIER: "main",
      OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
    },
    changedPlannerSource: `export const createNodeWorkerE2eTestShards = () => ${JSON.stringify(rows)};`,
  });
  expect(result.status, result.output).toBe(0);
  const matrix = JSON.parse(result.outputs.checks_node_core_nondist_matrix!);
  const workerRows = matrix.include.filter((row: { targets?: string[] }) => row.targets?.length);
  expect(workerRows).toHaveLength(2);
  expect(workerRows.every((row: { plan_concurrency?: number }) => row.plan_concurrency === 1)).toBe(
    true,
  );
  const selected = matrix.include.flatMap((row: { targets?: string[] }) => row.targets ?? []);
  expect(selected.toSorted()).toEqual(expectedFiles);
  const optionsLine = result.output
    .split("\n")
    .find((line) => line.startsWith("node-test-plan-options:"))!;
  expect(JSON.parse(optionsLine.slice("node-test-plan-options:".length)).compactNodeJobCap).toBe(
    77 - rows.length,
  );
});
