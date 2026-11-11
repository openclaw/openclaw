import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildPluginControlUi } from "./plugins-control-ui-build.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);

async function fixture(root: string, pluginPath: string, graphPath: string) {
  const rootDir = path.join(root, pluginPath);
  const dependency = path.join(root, graphPath, "dependency");
  await fs.mkdir(path.join(rootDir, "node_modules"), { recursive: true });
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "browser-fixture", type: "module" }),
  );
  await fs.writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "dependency", type: "module", exports: "./index.js" }),
  );
  await fs.writeFile(path.join(dependency, "index.js"), 'export const value = "original";');
  await fs.symlink(dependency, path.join(rootDir, "node_modules/dependency"), "dir");
  await fs.symlink(
    path.dirname(require.resolve("esbuild/package.json")),
    path.join(rootDir, "node_modules/esbuild"),
    "dir",
  );
  await fs.writeFile(
    path.join(rootDir, "index.ts"),
    'import "./style.css"; import { events } from "./shared.js"; import { value } from "dependency"; export async function observe() { const a = await import("./a.js"); const b = await import("./b.js"); return { events, value, lazyValues: [a.value, b.value], distinct: a.identity !== b.identity }; }',
  );
  await fs.writeFile(path.join(rootDir, "style.css"), ".fixture { color: red; }");
  await fs.writeFile(path.join(rootDir, "shared.js"), "export const events = [];");
  // Separate modules have intentionally identical bytes but distinct activation identity.
  for (const name of ["a", "b"]) {
    await fs.writeFile(
      path.join(rootDir, name + ".js"),
      'import { events } from "./shared.js"; export { value } from "dependency"; events.push("activated"); export const identity = {};',
    );
  }
  return { rootDir, source: "index.ts", dependency };
}

it("keeps checkout and dependency-store paths out of asset identity without merging lazy modules", async () => {
  const root = tempDirs.make("control-ui-reproducibility-");
  const first = await fixture(root, "first/plugin", "first-graph");
  const second = await fixture(root, "relocated/deeper/plugin", "second/deeper/package-store");
  const a = await buildPluginControlUi(first);
  const b = await buildPluginControlUi(second);
  expect(a).toEqual(b);
  for (const project of [first, second]) {
    const declaration = await buildPluginControlUi({ ...project, check: true });
    const built = await import(pathToFileURL(path.join(project.rootDir, declaration.entry)).href);
    expect(await built.observe()).toEqual({
      events: ["activated", "activated"],
      value: "original",
      lazyValues: ["original", "original"],
      distinct: true,
    });
    const stylesheet = declaration.styles?.[0];
    assert.ok(stylesheet, "CSS input must produce a published stylesheet");
    expect(await fs.readFile(path.join(project.rootDir, stylesheet), "utf8")).toContain(
      "color:red",
    );
  }
  const directory = path.dirname(a.entry);
  const names = await fs.readdir(path.join(first.rootDir, directory));
  for (const name of names) {
    expect(await fs.readFile(path.join(first.rootDir, directory, name))).toEqual(
      await fs.readFile(path.join(second.rootDir, directory, name)),
    );
  }
  await fs.writeFile(path.join(second.dependency, "index.js"), 'export const value = "changed";');
  const changed = await buildPluginControlUi(second);
  expect(changed.entry).not.toBe(a.entry);
  const rebuilt = await import(pathToFileURL(path.join(second.rootDir, changed.entry)).href);
  expect(await rebuilt.observe()).toEqual({
    events: ["activated", "activated"],
    value: "changed",
    lazyValues: ["changed", "changed"],
    distinct: true,
  });
  await fs.appendFile(path.join(second.rootDir, changed.entry), "\n// corrupted generation");
  await expect(buildPluginControlUi({ ...second, check: true })).rejects.toThrow(
    "missing or stale",
  );
});
