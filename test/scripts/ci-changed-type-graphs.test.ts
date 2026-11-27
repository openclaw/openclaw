import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreTsgoGraph } from "../../scripts/check-tsgo-core-boundary.mts";
import {
  expandTsgoExecutionGraphs,
  selectChangedCiTsgoGraphs,
  resolveCiTsgoGraphs,
  TSGO_CI_GRAPHS,
  TSGO_CI_ADDITIONAL_GRAPHS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { createChangedCiTypeCheckPlan } from "../../scripts/run-tsgo-core-test-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const inspectGraphs = vi.hoisted(() => vi.fn<() => Promise<CoreTsgoGraph[]>>());
vi.mock("../../scripts/check-tsgo-core-boundary.mts", () => ({
  inspectCiTsgoCheckGraphs: inspectGraphs,
}));
afterEach(() => inspectGraphs.mockReset());

const source = "src/value.ts";
const allocation = "config/test-lines-allocations/ci-example.txt";
const extension = "extensions/example/value.ts";
function workspace(files = [source]) {
  const cwd = tempDirs.make("ci-type-");
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), "export type Value = number;\n");
  }
  return cwd;
}
const fullPlan = { mode: "full", graphs: TSGO_CI_GRAPHS };
const graphs = (
  files: (name: string) => string[] = () => [],
  scope: Parameters<typeof expandTsgoExecutionGraphs>[0] = TSGO_CI_GRAPHS,
) =>
  expandTsgoExecutionGraphs(scope).map(({ name, config }) => ({
    name,
    config,
    roots: [],
    files: files(name),
  }));
const additionalInventory = (files: string[]) => graphs(() => files, TSGO_CI_ADDITIONAL_GRAPHS);
const noncoreInventory = additionalInventory([extension]);
type PlanOptions = Parameters<typeof createChangedCiTypeCheckPlan>[1];
async function expectFull(paths: string[], options: PlanOptions = {}, discovers = false) {
  if (!discovers) {
    inspectGraphs.mockRejectedValue(new Error("Unexpected graph discovery"));
  }
  expect(await createChangedCiTypeCheckPlan(paths, options)).toEqual(fullPlan);
  if (!discovers) {
    expect(inspectGraphs).not.toHaveBeenCalled();
  }
}

it("rejects empty, unowned, duplicate and overlapping graphs", () => {
  for (const names of [
    [],
    ["core", "core"],
    ["unknown"],
    ["test-root", "test-root-e2e"],
    ["test-root-e2e", "test-root"],
  ]) {
    expect(() => resolveCiTsgoGraphs(names)).toThrow("canonical");
  }
});

it.for([
  [],
  ["src/types/runtime.d.ts"],
  ["package.json"],
  [allocation],
  [source, "src/deleted.ts"],
  [allocation, "src/deleted.ts"],
])("keeps uncertain or deleted input full: %j", async (paths) => {
  if (paths.length !== 2) {
    expect(selectChangedCiTsgoGraphs(paths, graphs())).toBeUndefined();
  }
  await expectFull(paths, paths.length === 2 ? { cwd: workspace() } : {});
});

it("requires a parallel owner for noncore-only discovery", async () => {
  const paths = [extension, "docs/value.md", "ui/styles/value.css"];
  const cwd = workspace(paths);
  inspectGraphs.mockResolvedValue(additionalInventory([extension]));
  expect(
    await createChangedCiTypeCheckPlan(paths, { cwd, coreBoundaryOwner: "additional-checks" }),
  ).toEqual({ mode: "changed", graphs: expandTsgoExecutionGraphs(TSGO_CI_ADDITIONAL_GRAPHS) });
  await expectFull(paths, { cwd }, true);
});

it.each(["leaf", "directory", "traversal", "directory-file", "deleted-during", "symlink-during"])(
  "keeps nonphysical or replaced inputs full: %s",
  async (kind) => {
    const during = kind.endsWith("-during");
    const other = "extensions/example/other.ts";
    const cwd = workspace(during ? [extension, other] : [source]);
    mkdirSync(join(cwd, "extensions", "example"), { recursive: true });
    const file =
      kind === "traversal"
        ? "extensions/example/../../src/value.ts"
        : kind === "directory"
          ? "extensions/alias/value.ts"
          : extension;
    if (during) {
      inspectGraphs.mockImplementation(async () => {
        unlinkSync(join(cwd, file));
        if (kind === "symlink-during") {
          symlinkSync(join(cwd, other), join(cwd, file), "file");
        }
        return additionalInventory([file]);
      });
    } else if (kind === "directory") {
      symlinkSync(join(cwd, "src"), join(cwd, "extensions/alias"), "dir");
    } else if (kind === "directory-file") {
      mkdirSync(join(cwd, file));
    } else if (kind !== "traversal") {
      symlinkSync(join(cwd, "src/value.ts"), join(cwd, file), "file");
    }
    await expectFull([file], { cwd, coreBoundaryOwner: "additional-checks" }, during);
  },
);

it.each([
  ["missing", noncoreInventory.slice(0, -1), [extension]],
  ["duplicate", noncoreInventory.with(1, noncoreInventory[0]!), [extension]],
  ["unmatched", noncoreInventory, [extension, "extensions/example/other.ts"]],
  ["mixed", noncoreInventory, [extension, source]],
] as const)("rejects incomplete noncore discovery: %s", (_kind, inventory, paths) => {
  expect(selectChangedCiTsgoGraphs(paths, inventory, { scope: "noncore" })).toBeUndefined();
});

it.each([false, true])("checks all root consumers with allocation=%s", async (withAllocation) => {
  const file = "test/helpers/shared-type.ts";
  const paths = withAllocation ? [file, allocation] : [file];
  const consumers = ["test-root-tooling", "test-root-e2e"];
  const cwd = workspace([file]);
  const inventory = graphs((name) =>
    consumers.some((consumer) => consumer === name) ? [file] : [],
  );
  inspectGraphs.mockResolvedValue(inventory);
  const plan = await createChangedCiTypeCheckPlan(paths, { cwd });
  expect(plan.mode).toBe("changed");
  expect(plan.graphs.map(({ name }) => name)).toEqual(consumers);
  inspectGraphs.mockResolvedValue(inventory.slice(0, -1));
  await expectFull(paths, { cwd }, true);
});
