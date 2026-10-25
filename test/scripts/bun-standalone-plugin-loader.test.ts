import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { stageStandalonePluginLoader } from "../../scripts/lib/bun-standalone-plugins.mjs";
import { createStandaloneRequireAdapter } from "../../scripts/lib/bun-standalone-require.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

const configuredBun = process.env.OPENCLAW_BUN_PATH?.trim();
const bunCommand = configuredBun || "bun";
const hasBun = spawnSync(bunCommand, ["--version"], { timeout: 10_000 }).status === 0;

// Node-only test jobs do not provision Bun; an explicit compiler override must work.
it.skipIf(!configuredBun && !hasBun)(
  "keeps retained loader bytes independent of the staging directory",
  async () => {
    const root = temporary.make("standalone-plugin-loader-bytes-");
    const outputs: Buffer[] = [];
    for (const name of ["first", "second"]) {
      const outputRoot = path.join(root, name);
      const runtimeRoot = path.join(outputRoot, "runtime");
      const jitiRoot = path.join(runtimeRoot, "node_modules/jiti");
      fs.mkdirSync(jitiRoot, { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"openclaw"}');
      fs.writeFileSync(path.join(jitiRoot, "package.json"), '{"name":"jiti","main":"index.cjs"}');
      fs.writeFileSync(path.join(jitiRoot, "LICENSE"), "fixture license");
      fs.writeFileSync(path.join(jitiRoot, "index.cjs"), "exports.createJiti = () => 42;");
      const loader = await stageStandalonePluginLoader({
        runtimeRoot,
        outputRoot,
        build: async (options) => {
          const result = spawnSync(
            bunCommand,
            [
              "--eval",
              'const result = await Bun.build(JSON.parse(process.argv.at(-1))); if (!result.success) throw new AggregateError(result.logs, "Loader bundle failed");',
              JSON.stringify(options),
            ],
            { cwd: root, encoding: "utf8", timeout: 10_000 },
          );
          expect(result.status, result.stderr).toBe(0);
          return { success: true, logs: [] };
        },
      });
      outputs.push(fs.readFileSync(path.join(runtimeRoot, loader.modulePath)));
    }
    expect(outputs[0]).toEqual(outputs[1]);
  },
);

it.each(["jit", "bytecode", "aot"])(
  "keeps native plugin loading and transforms lazy after relocation (%s)",
  async (mode) => {
    const root = temporary.make("standalone-plugin-loader-");
    const artifact = path.join(root, "artifact");
    const runtimeRoot = path.join(artifact, "runtime");
    const jitiRoot = path.join(runtimeRoot, "node_modules/jiti");
    fs.mkdirSync(jitiRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"openclaw"}');
    fs.writeFileSync(path.join(jitiRoot, "package.json"), '{"name":"jiti","main":"index.cjs"}');
    fs.writeFileSync(path.join(jitiRoot, "LICENSE"), "fixture license");
    fs.writeFileSync(
      path.join(jitiRoot, "index.cjs"),
      `globalThis.fixtureLoaderEvaluations = (globalThis.fixtureLoaderEvaluations ?? 0) + 1;
exports.createJiti = () => require("node:querystring").parse("result=fixture%20factory").result;`,
    );
    const loader = await stageStandalonePluginLoader({
      runtimeRoot,
      outputRoot: artifact,
      build: async (options) => {
        const result = await build({
          entryPoints: options.entrypoints,
          outdir: options.outdir,
          entryNames: "index",
          outExtension: { ".js": ".cjs" },
          platform: "node",
          format: options.format,
          bundle: true,
        });
        return { success: true, logs: result.warnings };
      },
    });
    const adapter = createStandaloneRequireAdapter({
      runtimeRoot,
      embeddedPaths: {},
      pluginLoader: loader,
    });
    const nativeAdapter = createStandaloneNativeAdapter({ runtimeRoot, parse });
    nativeAdapter.discover([loader.modulePath]);
    expect(nativeAdapter.builtinModules).toEqual(["node:module", "node:querystring"]);
    const builtins = adapter.finalize(nativeAdapter.builtinModules);
    fs.writeFileSync(path.join(artifact, "plugin.cjs"), "module.exports = { value: 42 };");
    fs.writeFileSync(
      path.join(artifact, "embedded.cjs"),
      'module.exports = { value: "embedded" };',
    );
    expect(fs.existsSync(path.join(artifact, "plugin-loader-entry.cjs"))).toBe(false);
    fs.writeFileSync(
      path.join(artifact, "bootstrap.mjs"),
      `import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("./runtime/", import.meta.url));
const imageEntry = path.join(path.dirname(root), "embedded.cjs");
const embedded = (filename) => filename === imageEntry ? imageEntry : undefined;
const commonJsEntries = new Set();
globalThis.__openclawStandaloneNativeResolve = () => undefined;
globalThis.__openclawStandaloneBuildInfo = Object.freeze({ mode: ${JSON.stringify(mode)} });
const resolveFilename = Module._resolveFilename;
${adapter.bootstrap.replace(builtins.search, builtins.replacement)}
assert.equal(Module._resolveFilename, resolveFilename);
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
const native = globalThis.__openclawStandaloneCreateRequire(createRequire, import.meta.url);
const loaderPath = path.join(root, "node_modules/@openclaw/plugin-loader/index.cjs");
assert.equal(native.cache[loaderPath], undefined);
assert.equal(native(imageEntry).value, "embedded");
assert.equal(native.cache[loaderPath], undefined);
assert.deepEqual(native("./plugin.cjs"), { value: 42 });
assert.equal(native("./plugin.cjs"), native("./plugin.cjs"));
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
const first = globalThis.openclawStandaloneLoadJitiFactory();
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
assert.equal(first(), "fixture factory");
assert.equal(globalThis.openclawStandaloneLoadJitiFactory(), first);
assert.equal(globalThis.fixtureLoaderEvaluations, 1);
console.log("lazy relocated loader");`,
    );
    const plan = planStandaloneRuntime(runtimeRoot, loader.files);
    expect(plan.pruning.categories).toMatchObject({ pluginLoader: { files: 3 } });
    pruneStandaloneRuntime(plan);
    const moved = path.join(root, "relocated");
    fs.renameSync(artifact, moved);
    expect(fs.existsSync(path.join(moved, "runtime/node_modules/jiti"))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(moved, "runtime/node_modules/@openclaw/plugin-loader/LICENSE"),
        "utf8",
      ),
    ).toBe("fixture license");
    const result = spawnSync(process.execPath, [path.join(moved, "bootstrap.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("lazy relocated loader");
  },
);
