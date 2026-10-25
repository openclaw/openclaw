import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const configuredBun = process.env.OPENCLAW_BUN_PATH?.trim();
const bunCommand = configuredBun || "bun";
const hasBun = spawnSync(bunCommand, ["--version"], { timeout: 10_000 }).status === 0;

it.skipIf(!configuredBun && !hasBun)(
  "excludes orphan dynamic chunks while rejecting reachable unrendered module URLs",
  () => {
    const root = temporary.make("standalone-bundle-reachability-");
    const script = path.join(root, "bundle.mjs");
    fs.writeFileSync(
      script,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleStandaloneModules } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-bundle.mjs", import.meta.url).href)};
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
  const built = await bundleStandaloneModules({
    root: stage,
    entrypoints: [entry, ...(mode === "declared" ? [leaf] : [])],
    outdir: output,
    target: "bun",
    format: "esm",
    splitting: true,
    minify: { syntax: true },
    define: { BUILD_FLAG: String(mode !== "reachable") },
    metafile: true,
  }, Bun.build, createStandaloneSourceParser());
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
    );
    const result = spawnSync(bunCommand, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("orphan removed; reachable and declared markers rejected");
  },
);

// Node-only CI does not provision Bun; an explicit compiler override must work.
it.skipIf(!configuredBun && !hasBun)(
  "keeps split modules reproducible and retains resources from metafile inputs",
  () => {
    const root = temporary.make("standalone-bundle-");
    const script = path.join(root, "bundle.mjs");
    fs.writeFileSync(
      script,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleStandaloneModules } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-bundle.mjs", import.meta.url).href)};
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
  fs.writeFileSync(path.join(runtime, "shared.cjs"), "module.exports = 2;");
  fs.writeFileSync(path.join(runtime, "entry.mjs"), 'import { shared } from "fixture-native"; import asset from "./fixture.bin"; console.log(JSON.stringify([shared + require("./shared.cjs"), asset.endsWith(".bin"), __dirname, __filename]));');
  fs.writeFileSync(path.join(runtime, "worker.mjs"), 'import { shared } from "fixture-native"; console.log(shared + require("./shared.cjs") + 1);');
  const native = createStandaloneNativeAdapter({ runtimeRoot: runtime, parse: createStandaloneSourceParser() });
  const output = path.join(stage, "modules");
  const built = await bundleStandaloneModules({
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
  }, Bun.build, createStandaloneSourceParser());
  assert.equal(built.success, true, String(built.logs));
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
    );
    const result = spawnSync(bunCommand, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("identical split modules and valid metafile inputs");
  },
);
