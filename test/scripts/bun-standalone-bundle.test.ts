import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const configuredBun = process.env.OPENCLAW_BUN_PATH?.trim();
const bunCommand = configuredBun || "bun";
const hasBun = spawnSync(bunCommand, ["--version"], { timeout: 10_000 }).status === 0;

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
  fs.writeFileSync(path.join(runtime, "entry.mjs"), 'import { shared } from "fixture-native"; console.log(shared + 2);');
  fs.writeFileSync(path.join(runtime, "worker.mjs"), 'import { shared } from "fixture-native"; console.log(shared + 3);');
  const native = createStandaloneNativeAdapter({ runtimeRoot: runtime, parse: createStandaloneSourceParser() });
  const output = path.join(stage, "modules");
  const built = await bundleStandaloneModules({
    root: stage,
    entrypoints: [path.join(runtime, "entry.mjs"), path.join(runtime, "worker.mjs")],
    outdir: output,
    target: "bun",
    format: "esm",
    splitting: true,
    metafile: true,
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  }, Bun.build);
  assert.equal(built.success, true, String(built.logs));
  const resources = native.finalize({ metafile: built.metafile }).files;
  assert.ok(resources.some(file => file.source === "node_modules/fixture-native/runtime.wasm"));
  const files = Object.fromEntries(await Promise.all(built.outputs.map(async file => [path.relative(output, file.path), await file.text()])));
  const child = Bun.spawnSync([process.execPath, path.join(output, "runtime/entry.js")]);
  assert.equal(child.exitCode, 0, child.stderr.toString());
  assert.equal(child.stdout.toString().trim(), "42");
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
