import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createJiti } from "./jiti-factory.js";
import { inspectPluginSourceDependencies } from "./plugin-generation-source-inspection.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { visitPluginSourceReferences } from "./plugin-source-references.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["import.meta", 'import.meta["url"]', "import.meta.main"])(
  "captures dependencies beside retained %s without evaluating the plugin",
  (expression) => {
    const root = temp.make("plugin-inspection-meta-");
    const entryFile = path.join(root, "index.mjs");
    const dependency = path.join(root, "dependency.mjs");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(dependency, "export const value = 42;");
    fs.writeFileSync(
      entryFile,
      `const meta = ${expression}; import { value } from "./dependency.mjs"; throw new Error("inspection must not execute plugin code");`,
    );

    const inspection = inspectPluginSourceDependencies([{ rootDir: root, entryFile }]);
    expect(inspection.unresolved).toEqual([]);
    expect(inspection.files).toContain(dependency);
    expect(() => inspection.assertSourceCurrent()).not.toThrow();
  },
);

it("traces a dependency that assigns to import.meta.url", () => {
  const root = temp.make("plugin-inspection-meta-assignment-");
  const entryFile = path.join(root, "index.mjs");
  const codec = path.join(root, "codec.mjs");
  const glue = path.join(root, "glue.mjs");
  const resolved = path.join(root, "resolved.mjs");
  fs.writeFileSync(entryFile, `export const load = () => import("./codec.mjs");`);
  fs.writeFileSync(
    codec,
    `import path from "node:path";
     import "./glue.mjs";
     if (import.meta.url === undefined) {
       import.meta.url = "https://localhost";
       ({ href: import.meta.url } = new URL("https://localhost"));
     }
     export const wasm = new URL("codec.wasm", import.meta.url);
     export const schema = path.join(import.meta.dirname, "schema.json");
     export const next = import.meta.resolve("./resolved.mjs");`,
  );
  fs.writeFileSync(glue, "export {};");
  fs.writeFileSync(resolved, "export {};");

  const inspection = inspectPluginSourceDependencies([{ rootDir: root, entryFile }]);
  expect(inspection.references).toEqual([
    { source: entryFile, specifier: "./codec.mjs", target: codec },
    { source: codec, specifier: "./glue.mjs", target: glue },
    { source: codec, specifier: "./resolved.mjs", target: resolved },
  ]);
  expect(inspection.unresolved).toEqual([]);

  const visited: string[] = [];
  visitPluginSourceReferences(
    codec,
    fs.readFileSync(codec, "utf8"),
    createJiti(codec, { fsCache: false, moduleCache: false }),
    (reference, kind) => visited.push(`${kind} ${reference}`),
  );
  expect(visited).toEqual(
    expect.arrayContaining(["asset codec.wasm", "asset schema.json", "import ./resolved.mjs"]),
  );
});

it("names the dependency whose source cannot be parsed", () => {
  const root = temp.make("plugin-inspection-parse-failure-");
  const entryFile = path.join(root, "index.mjs");
  const broken = path.join(root, "broken.mjs");
  fs.writeFileSync(entryFile, `export const load = () => import("./broken.mjs");`);
  fs.writeFileSync(broken, "\nconst pattern = /(/;");

  expect(() => inspectPluginSourceDependencies([{ rootDir: root, entryFile }])).toThrow(
    expect.objectContaining({
      name: "SyntaxError",
      message: expect.stringContaining(
        `${broken}: could not parse transformed source: Invalid regular expression`,
      ),
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
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name, main: "index.cjs", dependencies: { [dependency]: "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(directory, "index.cjs"),
      `require('${dependency}'); throw new Error('inspection must not execute plugin code');`,
    );
    fs.symlinkSync(target, path.join(directory, "node_modules", dependency), "junction");
  }

  const readdir = fs.readdirSync;
  const followedLinks = new Set<string>();
  vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
    const entries = readdir(...args);
    for (const entry of entries) {
      if (
        entry instanceof fs.Dirent &&
        entry.parentPath.startsWith(captures + path.sep) &&
        fs.realpathSync(entry.parentPath) !== entry.parentPath
      ) {
        followedLinks.add(entry.parentPath);
      }
    }
    return entries;
  });
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
  expect(() => inspection.assertSourceCurrent()).not.toThrow();
  expect(fs.readdirSync(captures)).toEqual([]);
  expect(followedLinks.size).toBe(0);
});
