import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const configuredBun = process.env.OPENCLAW_BUN_PATH?.trim();
const bunCommand = configuredBun || "bun";
const hasBun = spawnSync(bunCommand, ["--version"], { timeout: 10_000 }).status === 0;

function runBundleFixture(
  prefix: string,
  source: (root: string) => string,
  expectedOutput: string,
): void {
  const root = temporary.make(prefix);
  const script = path.join(root, "bundle.mjs");
  fs.writeFileSync(script, source(root));
  const result = spawnSync(bunCommand, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expectedOutput);
}

it.skipIf(!configuredBun && !hasBun)(
  "excludes orphan dynamic chunks while rejecting reachable unrendered module URLs",
  () => {
    runBundleFixture(
      "standalone-bundle-reachability-",
      (root) => `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleStandaloneModules, finalizeStandaloneModules } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-bundle.mjs", import.meta.url).href)};
import { assertNoUnrenderedModuleUrls } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-imports.mjs", import.meta.url).href)};
import { createStandaloneSourceParser } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-source-parser.mjs", import.meta.url).href)};
const root = ${JSON.stringify(root)};
for (const mode of ["orphan", "reachable", "declared"]) {
  const stage = path.join(root, mode);
  fs.mkdirSync(stage);
  const entry = path.join(stage, "entry.ts");
  const leaf = path.join(stage, "leaf.ts");
  fs.writeFileSync(entry, 'export function load() { if (BUILD_FLAG) return; return import("./leaf.ts"); }');
  fs.writeFileSync(leaf, 'export function read() { throw Error("OPENCLAW_UNRENDERED_MODULE_URL:fixture.ts"); }');
  const output = path.join(stage, "modules");
  const options = {
    root: stage,
    entrypoints: [entry, ...(mode === "declared" ? [leaf] : [])],
    outdir: output,
    target: "bun",
    format: "esm",
    splitting: true,
    minify: { syntax: true },
    define: { BUILD_FLAG: String(mode !== "reachable") },
    metafile: true,
  };
  const first = await bundleStandaloneModules(options, Bun.build);
  const built = await finalizeStandaloneModules(options, first, Bun.build, createStandaloneSourceParser(), { sourceAot: true });
  assert.equal(built.success, true, String(built.logs));
  const check = async () => {
    for (const artifact of built.outputs) {
      assertNoUnrenderedModuleUrls(await artifact.text(), artifact.path);
    }
  };
  if (mode === "orphan") {
    await check();
    assert.equal(built.outputs.length, 1);
    assert.equal(built.entryOutputs.length, 1);
    assert.equal(fs.readdirSync(output).length, 1);
    assert.ok(Object.hasOwn(built.metafile.inputs, "leaf.ts"), "retain original source provenance");
    assert.equal(Object.hasOwn(built.runtimeMetafile.inputs, "leaf.ts"), false);
    assert.deepEqual(Object.values(built.runtimeMetafile.outputs)[0].imports, []);
    const loaded = await import(new URL("file://" + built.outputs[0].path));
    assert.equal(loaded.load(), undefined);
  } else {
    await assert.rejects(check, /An unrendered source module URL survived bundling/);
    assert.equal(built.entryOutputs.length, mode === "declared" ? 2 : 1);
  }
}
console.log("orphan removed; reachable and declared markers rejected");
`,
      "orphan removed; reachable and declared markers rejected",
    );
  },
);

// Node-only CI does not provision Bun; an explicit compiler override must work.
it.skipIf(!configuredBun && !hasBun)(
  "removes dead exports inside live chunks without removing namespace or declared exports",
  () => {
    runBundleFixture(
      "standalone-bundle-exports-",
      (root) => `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundleStandaloneModules, finalizeStandaloneModules } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-bundle.mjs", import.meta.url).href)};
import { assertNoUnrenderedModuleUrls } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-imports.mjs", import.meta.url).href)};
import { createStandaloneSourceParser } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-source-parser.mjs", import.meta.url).href)};
for (const mode of ["dead", "namespace", "declared"]) {
  const stage = path.join(${JSON.stringify(root)}, mode);
  fs.mkdirSync(stage);
  const entry = path.join(stage, "entry.ts");
  const guarded = path.join(stage, "guarded.ts");
  const shared = path.join(stage, "shared.ts");
  fs.writeFileSync(entry, 'import { retained } from "./shared.ts"; export const result: number = retained();');
  fs.writeFileSync(guarded, 'export async function load() { if (BUILD_FLAG) return; return import("./shared.ts"); }');
  fs.writeFileSync(shared, 'export function retained(): number { return 7; } export function unused() { throw Error("OPENCLAW_UNRENDERED_MODULE_URL:shared.ts"); }');
  const options = {
    root: stage, entrypoints: [entry, guarded, ...(mode === "declared" ? [shared] : [])],
    outdir: path.join(stage, "modules"), splitting: true, target: "bun", format: "esm",
    metafile: true, minify: { syntax: true }, define: { BUILD_FLAG: String(mode !== "namespace") },
  };
  const first = await bundleStandaloneModules(options, Bun.build);
  assert.ok((await Promise.all(first.outputs.map(output => output.text()))).some(text => text.includes("OPENCLAW_UNRENDERED_MODULE_URL:")));
  const built = await finalizeStandaloneModules(options, first, Bun.build, createStandaloneSourceParser(), { sourceAot: true });
  assert.equal(built.metafile, first.metafile);
  const check = async () => {
    for (const output of built.outputs) assertNoUnrenderedModuleUrls(await output.text(), output.path);
  };
  if (mode === "dead") await check();
  else await assert.rejects(check, /An unrendered source module URL survived bundling/);
  const loaded = await import(pathToFileURL(built.entryOutputs[0]).href);
  assert.equal(loaded.result, 7);
  const lazy = await import(pathToFileURL(built.entryOutputs[1]).href);
  const namespace = mode === "declared"
    ? await import(pathToFileURL(built.entryOutputs[2]).href)
    : await lazy.load();
  if (mode === "dead") assert.equal(namespace, undefined);
  else {
    assert.deepEqual(Object.keys(namespace).sort(), ["retained", "unused"]);
    assert.throws(() => namespace.unused(), /OPENCLAW_UNRENDERED_MODULE_URL:shared.ts/);
  }
}
console.log("dead shared export removed; live namespace and declared exports preserved");
`,
      "dead shared export removed; live namespace and declared exports preserved",
    );
  },
);

it.skipIf(!configuredBun && !hasBun)(
  "rebases file-loader URLs when shared code moves into nested entry roots",
  () => {
    runBundleFixture(
      "standalone-bundle-assets-",
      (root) => `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleStandaloneModules, finalizeStandaloneModules } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-bundle.mjs", import.meta.url).href)};
import { createStandaloneSourceParser } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-source-parser.mjs", import.meta.url).href)};
const root = ${JSON.stringify(root)};
const entries = [];
for (const [name, directory] of [["first", "runtime/deep"], ["second", "runtime"]]) {
  const entry = path.join(root, directory, name + ".mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const owner = path.join(root, name + "-asset.mjs");
  fs.writeFileSync(path.join(root, name + ".bin"), "asset " + name);
  fs.writeFileSync(owner, 'import asset from "./' + name + '.bin"; export const location = new URL(asset, import.meta.url);');
  fs.writeFileSync(entry, 'import fs from "node:fs"; import { location } from ' + JSON.stringify(path.relative(path.dirname(entry), owner)) + '; console.log(fs.readFileSync(location, "utf8"));');
  entries.push(entry);
}
const guarded = path.join(root, "guarded.mjs");
fs.writeFileSync(guarded, 'export function read() { if (BUILD_FLAG) return; return [import("./first-asset.mjs"), import("./second-asset.mjs")]; }');
const options = {
  root, entrypoints: [...entries, guarded], outdir: path.join(root, "modules"),
  splitting: true, target: "bun", format: "esm", metafile: true,
  minify: { syntax: true }, define: { BUILD_FLAG: "true" }, loader: { ".bin": "file" },
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
};
const first = await bundleStandaloneModules(options, Bun.build);
assert.equal(first.success, true, String(first.logs));
const read = files => files.slice(0, 2).map(file => {
  const result = Bun.spawnSync([process.execPath, file]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
});
assert.deepEqual(read(first.entryOutputs), ["asset first", "asset second"]);
const linked = await finalizeStandaloneModules(options, first, Bun.build, createStandaloneSourceParser(), { sourceAot: true });
assert.equal(linked.success, true, String(linked.logs));
assert.deepEqual(read(linked.entryOutputs), ["asset first", "asset second"]);
console.log("both nested roots read their assets after shared chunks move");
`,
      "both nested roots read their assets after shared chunks move",
    );
  },
);

it.skipIf(!configuredBun && !hasBun).each([
  { sourceAot: false, mode: "emitted JS" },
  { sourceAot: true, mode: "source AOT" },
])(
  "keeps $mode split modules reproducible and retains resources from metafile inputs",
  ({ sourceAot }) => {
    runBundleFixture(
      "standalone-bundle-",
      (root) => `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleStandaloneModules, finalizeStandaloneModules } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-bundle.mjs", import.meta.url).href)};
import { rewriteStandaloneImports } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-imports.mjs", import.meta.url).href)};
import { createStandaloneNativeAdapter } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-native.mjs", import.meta.url).href)};
import { createStandaloneSourceParser } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-source-parser.mjs", import.meta.url).href)};
const root = ${JSON.stringify(root)};
const results = [];
for (const directory of ["first", "second"]) {
  const stage = path.join(root, directory);
  const runtime = path.join(stage, "runtime");
  const dependency = path.join(runtime, "node_modules/fixture-native");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ dependencies: { "fixture-native": "1.0.0" } }));
  fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "fixture-native", version: "1.0.0", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(dependency, "index.js"), "export const shared = 40;");
  fs.writeFileSync(path.join(dependency, "runtime.wasm"), "synthetic resource");
  fs.writeFileSync(path.join(runtime, "fixture.bin"), "retained asset");
  fs.writeFileSync(path.join(runtime, "shared.cjs"), 'module.exports = require("./shared.mjs").value;');
  fs.writeFileSync(path.join(runtime, "shared.mjs"), "export const value = 2;");
  fs.writeFileSync(path.join(runtime, "entry.mjs"), 'import { shared } from "fixture-native"; import asset from "./fixture.bin"; console.log(JSON.stringify([shared + require("./shared.cjs"), asset.endsWith(".bin"), __dirname, __filename]));');
  fs.writeFileSync(path.join(runtime, "worker.mjs"), 'import { shared } from "fixture-native"; console.log(shared + require("./shared.cjs") + 1);');
  const native = createStandaloneNativeAdapter({ runtimeRoot: runtime, parse: createStandaloneSourceParser() });
  const output = path.join(stage, "modules");
  const options = {
    root: stage,
    entrypoints: [path.join(runtime, "entry.mjs"), path.join(runtime, "worker.mjs")],
    outdir: output,
    target: "bun",
    format: "esm",
    splitting: true,
    loader: { ".bin": "file" },
    metafile: true,
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
    banner: 'globalThis.__openclawStandaloneNativePath = relative => "/relocated/runtime/" + relative;',
    plugins: [{ name: "standalone-imports", setup(build) {
      build.onLoad({ filter: /[.]m?js$/ }, ({ path: filename }) => ({
        contents: rewriteStandaloneImports({ contents: fs.readFileSync(filename, "utf8"), filename, runtimeRoot: runtime, embeddedPaths: {}, moduleAliases: {}, workerThreadsShim: "", parse: createStandaloneSourceParser() }),
        loader: "js",
      }));
    } }],
  };
  const sourceAot = ${JSON.stringify(sourceAot)};
  let builds = 0;
  const build = async options => {
    builds++;
    assert.ok(builds <= (sourceAot ? 2 : 1), "emitted JS must not be bundled twice");
    return Bun.build(options);
  };
  const first = await bundleStandaloneModules(options, build);
  const built = await finalizeStandaloneModules(options, first, build, createStandaloneSourceParser(), { sourceAot });
  assert.equal(built.success, true, String(built.logs));
  assert.equal(builds, sourceAot ? 2 : 1);
  if (!sourceAot) {
    assert.equal(built.outputs, first.outputs);
    assert.equal(built.entryOutputs, first.entryOutputs);
    assert.equal(built.runtimeMetafile, first.metafile);
    assert.equal(fs.existsSync(output + "-input"), false);
  }
  const resources = native.finalize({ metafile: built.runtimeMetafile }).files;
  assert.ok(resources.some(file => file.source === "node_modules/fixture-native/runtime.wasm"));
  const files = Object.fromEntries(await Promise.all(built.outputs.map(async file => [path.relative(output, file.path), await file.text()])));
  assert.ok(Object.values(files).includes("retained asset"));
  const child = Bun.spawnSync([process.execPath, path.join(output, "runtime/entry.js")]);
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.deepEqual(JSON.parse(child.stdout.toString()), [42, true, "/relocated/runtime/.", "/relocated/runtime/entry.mjs"]);
  results.push({ files, resources });
}
assert.deepEqual(results[0], results[1]);
console.log("identical split modules and valid metafile inputs");
`,
      "identical split modules and valid metafile inputs",
    );
  },
);
