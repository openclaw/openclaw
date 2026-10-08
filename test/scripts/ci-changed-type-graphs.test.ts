import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreTsgoGraph } from "../../scripts/check-tsgo-core-boundary.mts";
import {
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
// mock-isolation: graph selection fixtures must not compile or mutate the real checkout artifacts.
vi.mock("../../scripts/prepare-extension-package-boundary-artifacts.mts", () => ({
  withPreparedControlUiPluginArtifacts: async (_root: string, read: () => Promise<unknown>) =>
    read(),
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
    expect(
      selectChangedCiTsgoGraphs(
        [sharedType, "docs/plugins/sdk-subpaths.md", "docs/example.mdx", "ui/src/styles/chat.css"],
        inventory,
      )?.map((graph) => graph.name),
    ).toEqual(consumers);
  });

  it.for([
    [],
    ["src/types/runtime.d.ts"],
    ["package.json"],
    ["extensions/github/browser/pull-requests.ts"],
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

  it.each([undefined, "additional-checks"] as const)(
    "still discovers core consumers when the parallel boundary owner is %s",
    async (coreBoundaryOwner) => {
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
      expect(
        await createChangedCiTypeCheckPlan(["src/value.ts"], { cwd, coreBoundaryOwner }),
      ).toEqual({ mode: "changed", graphs: [{ name: "ui", config: "tsconfig.ui.json" }] });
      expect(inspectGraphs).toHaveBeenCalledOnce();
    },
  );

  it("keeps every noncore consumer when a parallel owner checks the core boundary", async () => {
    const cwd = tempDirs.make("ci-type-extension-");
    const paths = ["extensions/example/value.ts", "docs/value.md", "ui/styles/value.css"];
    for (const file of paths) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), "export type Value = number;\n");
    }
    inspectGraphs.mockResolvedValue(
      TSGO_CI_ADDITIONAL_GRAPHS.map((graph) => ({
        ...graph,
        roots: [],
        files: [paths[0]!],
      })),
    );
    expect(
      await createChangedCiTypeCheckPlan(paths, { cwd, coreBoundaryOwner: "additional-checks" }),
    ).toEqual({ mode: "changed", graphs: TSGO_CI_ADDITIONAL_GRAPHS });
    // Without a separate owner, a partial inventory cannot authorize narrowing.
    expect(await createChangedCiTypeCheckPlan(paths, { cwd })).toEqual({
      mode: "full",
      graphs: TSGO_CI_GRAPHS,
    });
  });

  it.each(["leaf", "directory", "traversal", "directory-file"])(
    "retains every compiler for a nonphysical extension input (%s)",
    async (kind) => {
      const cwd = tempDirs.make("ci-type-extension-alias-");
      mkdirSync(join(cwd, "src"));
      mkdirSync(join(cwd, "extensions", "example"), { recursive: true });
      writeFileSync(join(cwd, "src/value.ts"), "export type Value = number;\n");
      const file =
        kind === "traversal"
          ? "extensions/example/../../src/value.ts"
          : kind === "directory"
            ? "extensions/alias/value.ts"
            : "extensions/example/value.ts";
      if (kind === "directory") {
        symlinkSync(join(cwd, "src"), join(cwd, "extensions/alias"), "dir");
      } else if (kind === "directory-file") {
        mkdirSync(join(cwd, file));
      } else if (kind !== "traversal") {
        symlinkSync(join(cwd, "src/value.ts"), join(cwd, file), "file");
      }
      inspectGraphs.mockRejectedValue(
        new Error("Aliases must retain all graphs without discovery"),
      );
      expect(
        await createChangedCiTypeCheckPlan([file], { cwd, coreBoundaryOwner: "additional-checks" }),
      ).toEqual({ mode: "full", graphs: TSGO_CI_GRAPHS });
      expect(inspectGraphs).not.toHaveBeenCalled();
    },
  );

  it.each(["deleted", "symlink"])(
    "retains every compiler when an extension input becomes %s during discovery",
    async (change) => {
      const cwd = tempDirs.make("ci-type-extension-replaced-");
      const file = "extensions/example/value.ts";
      mkdirSync(join(cwd, "extensions/example"), { recursive: true });
      writeFileSync(join(cwd, file), "export type Value = number;\n");
      const target = join(cwd, "extensions/example/other.ts");
      writeFileSync(target, "export type Value = number;\n");
      inspectGraphs.mockImplementation(async () => {
        unlinkSync(join(cwd, file));
        if (change === "symlink") {
          symlinkSync(target, join(cwd, file), "file");
        }
        return TSGO_CI_ADDITIONAL_GRAPHS.map((graph) => ({ ...graph, roots: [], files: [file] }));
      });
      expect(
        await createChangedCiTypeCheckPlan([file], { cwd, coreBoundaryOwner: "additional-checks" }),
      ).toEqual({ mode: "full", graphs: TSGO_CI_GRAPHS });
    },
  );

  it.each(["missing", "duplicate", "unmatched", "mixed"])(
    "refuses incomplete or inapplicable noncore discovery (%s)",
    (kind) => {
      const file = "extensions/example/value.ts";
      const inventory: { config: string; files: string[] }[] = TSGO_CI_ADDITIONAL_GRAPHS.map(
        ({ config }) => ({ config, files: [file] }),
      );
      const paths = [file];
      if (kind === "missing") {
        inventory.pop();
      } else if (kind === "duplicate") {
        inventory[inventory.length - 1] = inventory[0]!;
      } else if (kind === "unmatched") {
        paths.push("extensions/example/other.ts");
      } else if (kind === "mixed") {
        paths.push("src/value.ts");
      }
      expect(selectChangedCiTsgoGraphs(paths, inventory, { scope: "noncore" })).toBeUndefined();
    },
  );
});
