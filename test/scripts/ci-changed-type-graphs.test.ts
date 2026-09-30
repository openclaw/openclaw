import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreTsgoGraph } from "../../scripts/check-tsgo-core-boundary.mts";
import {
  selectChangedCiTsgoGraphs,
  resolveCiTsgoGraphs,
  TSGO_CI_GRAPHS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { createChangedCiTypeCheckPlan } from "../../scripts/run-tsgo-core-test-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const inspectGraphs = vi.hoisted(() => vi.fn<() => Promise<CoreTsgoGraph[]>>());
vi.mock("../../scripts/check-tsgo-core-boundary.mts", () => ({
  inspectCiTsgoCheckGraphs: inspectGraphs,
}));
afterEach(() => inspectGraphs.mockReset());

describe("changed CI compiler graph selection", () => {
  const sharedType = "packages/example/src/types.ts";
  const graphs = () =>
    TSGO_CI_GRAPHS.map(({ name, config }) => ({ name, config, files: new Array<string>() }));

  it("admits only canonical graphs while preserving their execution owner's order", () => {
    expect(resolveCiTsgoGraphs(["test-root", "core-test-agents-tools", "ui"])).toEqual([
      { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
      {
        name: "core-test-agents-tools",
        config: "test/tsconfig/tsconfig.core.test.agents-tools.json",
      },
      { name: "ui", config: "tsconfig.ui.json" },
    ]);
    for (const names of [[], ["core", "core"], ["unknown"], ["core", "../../unowned.json"]]) {
      expect(() => resolveCiTsgoGraphs(names)).toThrow("canonical");
    }
  });

  it("keeps type-only consumers in every compiler family", () => {
    const inventory = graphs();
    const consumers = [
      "core",
      "ui",
      "core-test-agents-tools",
      "extensions",
      "extensions-test",
      "scripts",
      "test-root",
    ];
    for (const graph of inventory) {
      if (consumers.includes(graph.name)) {
        graph.files.push(sharedType);
      }
    }
    expect(selectChangedCiTsgoGraphs([sharedType], inventory)?.map((graph) => graph.name)).toEqual(
      consumers,
    );
  });

  it.for([["docs/plugins/sdk-subpaths.md", "docs/example.mdx"], ["ui/src/styles/chat.css"]])(
    "keeps a mixed source change scoped to its compiler consumers alongside %j",
    (nonCompilerPaths) => {
      const inventory = graphs();
      inventory.find(({ name }) => name === "ui")!.files.push(sharedType);
      expect(
        selectChangedCiTsgoGraphs([sharedType, ...nonCompilerPaths], inventory)?.map(
          (graph) => graph.name,
        ),
      ).toEqual(["ui"]);
    },
  );

  it.for([
    [],
    ["src/missing.ts"],
    ["src/types/runtime.d.ts"],
    ["test/tsconfig/tsconfig.test.root.json"],
    ["package.json"],
    ["unclassified/module.ts"],
    ["docs/plugins/sdk-subpaths.md", "ui/src/styles/chat.css"],
    [sharedType, "src/config/catalog.json"],
  ])("retains all compilers without discovery for uncertain input %j", async (paths) => {
    expect(selectChangedCiTsgoGraphs(paths, graphs())).toBeUndefined();
    inspectGraphs.mockRejectedValue(new Error("Full plans must not enumerate compiler inputs"));
    expect(await createChangedCiTypeCheckPlan(paths)).toEqual({
      mode: "full",
      graphs: TSGO_CI_GRAPHS,
    });
    expect(inspectGraphs).not.toHaveBeenCalled();
  });

  it("retains full planning for deleted paths alongside existing source", async () => {
    const cwd = tempDirs.make("ci-type-deleted-");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/value.ts"), "export type Value = number;\n");
    inspectGraphs.mockRejectedValue(new Error("Deleted inputs must not enumerate compilers"));
    for (const deleted of ["src/deleted.ts", "docs/deleted.md", "ui/deleted.css"]) {
      expect(await createChangedCiTypeCheckPlan(["src/value.ts", deleted], { cwd })).toEqual({
        mode: "full",
        graphs: TSGO_CI_GRAPHS,
      });
    }
    expect(inspectGraphs).not.toHaveBeenCalled();
  });

  it("still discovers compiler consumers for existing source-only changes", async () => {
    const cwd = tempDirs.make("ci-type-source-");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/value.ts"), "export type Value = number;\n");
    inspectGraphs.mockResolvedValue(
      graphs().map(({ name, config }) => ({
        name,
        config,
        roots: [],
        files: name === "ui" ? ["src/value.ts"] : [],
      })),
    );
    expect(await createChangedCiTypeCheckPlan(["src/value.ts"], { cwd })).toEqual({
      mode: "changed",
      graphs: [{ name: "ui", config: "tsconfig.ui.json" }],
    });
    expect(inspectGraphs).toHaveBeenCalledOnce();
  });

  it.each(["missing", "duplicate"])("refuses an incomplete %s compiler inventory", (kind) => {
    const inventory = graphs();
    inventory[0]!.files.push(sharedType);
    if (kind === "missing") {
      inventory.pop();
    } else {
      inventory[inventory.length - 1] = inventory[0]!;
    }
    expect(selectChangedCiTsgoGraphs([sharedType], inventory)).toBeUndefined();
  });
});
