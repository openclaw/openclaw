import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectPluginSourceDependencies } from "./plugin-generation-source-inspection.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

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
