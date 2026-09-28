import { describe, expect, it } from "vitest";
import {
  selectChangedCiTsgoGraphs,
  resolveCiTsgoGraphs,
  TSGO_CI_GRAPHS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";

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
  ])("retains all compilers for uncertain input %j", (paths) => {
    expect(selectChangedCiTsgoGraphs(paths, graphs())).toBeUndefined();
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
