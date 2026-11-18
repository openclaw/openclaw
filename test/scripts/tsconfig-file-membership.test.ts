import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { inspectCiTsgoCheckGraphs } from "../../scripts/check-tsgo-core-boundary.mts";
import {
  expandTsgoExecutionGraphs,
  TSGO_CI_ADDITIONAL_GRAPHS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "tsgo"])(
  "keeps repository and dependency declarations but excludes compiler libraries (%s)",
  async (typeChecker) => {
    vi.stubEnv("OPENCLAW_TYPECHECKER", typeChecker);
    const cwd = fs.realpathSync(tempDirs.make("tsconfig-membership-"));
    const { file, write } = fixtureFiles(cwd);
    write(
      "src/root.ts",
      'export type { Value } from "./value.js";\nexport type { Local } from "./lib.es5.js";\nexport type { Dependency } from "dependency";\n',
    );
    write("src/value.ts", "export type Value = number;\n");
    write("src/lib.es5.d.ts", "export type Local = string;\n");
    write("node_modules/dependency/package.json", '{"types":"lib.es5.d.ts"}\n');
    write("node_modules/dependency/lib.es5.d.ts", "export type Dependency = boolean;\n");
    for (const { config } of expandTsgoExecutionGraphs(TSGO_CI_ADDITIONAL_GRAPHS)) {
      write(
        config,
        JSON.stringify({
          compilerOptions: { noEmit: true, types: [], lib: ["es5"], module: "nodenext" },
          files: [file("src/root.ts")],
        }),
      );
    }
    const graphs = await inspectCiTsgoCheckGraphs({ cwd, scope: "noncore" });
    expect(graphs).toHaveLength(7);
    for (const graph of graphs) {
      expect(graph.files.toSorted()).toEqual([
        "node_modules/dependency/lib.es5.d.ts",
        "src/lib.es5.d.ts",
        "src/root.ts",
        "src/value.ts",
      ]);
    }
  },
);
