import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectPluginSourceDependencies } from "./plugin-generation-source-inspection.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("inspects retained import.meta reads and assignments without evaluating dependencies", () => {
  const root = temp.make("plugin-inspection-meta-assignment-");
  const entryFile = path.join(root, "index.mjs");
  const codec = path.join(root, "codec.mjs");
  const glue = path.join(root, "glue.mjs");
  const resolved = path.join(root, "resolved.mjs");
  const selected = (target: string) => ({ "module-sync": target, default: "./missing.mjs" });
  writeTree(root, {
    "package.json": {
      name: "inspection",
      type: "module",
      imports: { "#glue": selected("./glue.mjs") },
      exports: { "./resolved": selected("./resolved.mjs") },
    },
    "index.mjs": `export const load = () => import("./codec.mjs");`,
    "codec.mjs": `import path from "node:path";
     import "#glue";
     const meta = import.meta;
     const url = import.meta["url"];
     const main = import.meta.main;
     if (import.meta.url === undefined) {
       import.meta.url = "https://localhost";
       ({ href: import.meta.url } = new URL("https://localhost"));
     }
     export const wasm = new URL("codec.wasm", import.meta.url);
     export const schema = path.join(import.meta.dirname, "schema.json");
     export const next = import.meta.resolve("inspection/resolved");
     throw new Error("inspection must not execute plugin code");`,
    "glue.mjs": "export {};",
    "resolved.mjs": "export {};",
  });

  const inspection = inspectPluginSourceDependencies([{ rootDir: root, entryFile }]);
  expect(inspection.references).toEqual([
    { source: entryFile, specifier: "./codec.mjs", target: codec },
    { source: codec, specifier: "#glue", target: glue },
    { source: codec, specifier: "inspection/resolved", target: resolved },
  ]);
  expect(inspection.unresolved).toEqual([]);
});

it("names the dependency whose source cannot be parsed", () => {
  const root = temp.make("plugin-inspection-parse-failure-");
  const entryFile = path.join(root, "index.mjs");
  const broken = path.join(root, "broken.mjs");
  writeTree(root, {
    "index.mjs": `export const load = () => import("./broken.mjs");`,
    "broken.mjs": "\nconst pattern = /(/;",
  });

  expect(() => inspectPluginSourceDependencies([{ rootDir: root, entryFile }])).toThrow(
    expect.objectContaining({
      name: "SyntaxError",
      message: expect.stringContaining(`${broken}: could not parse transformed source`),
      cause: expect.any(SyntaxError),
    }),
  );
});

it("inspects a captured cyclic dependency graph without following its dependency links", () => {
  const root = temp.make("plugin-inspection-cycle-");
  const captures = fs.realpathSync(temp.make("plugin-inspection-captures-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  for (const directory of [alpha, beta]) {
    fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  }
  for (const [directory, name, dependency, target] of [
    [alpha, "alpha", "beta", beta],
    [beta, "beta", "alpha", alpha],
  ] as const) {
    writeTree(directory, {
      "package.json": {
        name,
        main: "index.cjs",
        dependencies: { [dependency]: "1.0.0" },
        imports: { "#peer": dependency },
        exports: { "module-sync": "./index.cjs", default: "./missing.cjs" },
      },
      "index.cjs": `require('${dependency}'); require('#peer'); throw new Error('inspection must not execute plugin code');`,
    });
    fs.symlinkSync(target, path.join(directory, "node_modules", dependency), "junction");
  }

  const inspection = withPluginSourceCaptureDirectory(captures, () =>
    inspectPluginSourceDependencies([{ rootDir: alpha, entryFile: path.join(alpha, "index.cjs") }]),
  );
  expect(inspection.unresolved).toEqual([]);
  expect(inspection.packageRoots.toSorted()).toEqual([alpha, beta].toSorted());
  expect(inspection.files.toSorted()).toEqual(
    [alpha, beta]
      .flatMap((directory) =>
        ["index.cjs", "package.json"].map((name) => path.join(directory, name)),
      )
      .toSorted(),
  );
  expect(fs.readdirSync(captures)).toEqual([]);
});
